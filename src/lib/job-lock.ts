// The restore job running right now (compare, plan or apply), shared with the backup runner so
// only one job — a backup or a restore — runs at a time. Kept on globalThis like the stores.
// Also: the same lock across workers (a row in Supabase, public.job_locks), whether this worker
// still takes new jobs (GitHub Actions ends a run after 6 hours), and the database writes a job
// leaves behind, which the worker waits for before it exits.
import crypto from 'node:crypto';
import os from 'node:os';
import { db, isConfigured } from './supabase';

export interface ActiveRestore {
  id: string;
  zone: string;
  /** What it is doing: comparing, planning or applying. */
  job: 'comparing' | 'planning' | 'applying';
  by: string;
  since: string;
  /** The Cloudflare credential it uses (monitoring leaves its token alone meanwhile). */
  credentialId?: string;
}

const g = globalThis as unknown as {
  __restoreJob?: { current: ActiveRestore | null };
  __jobWrites?: Set<Promise<unknown>>;
  __workerClock?: { startedAt: number; retiring: string | null };
  __jobLockOwner?: string;
  __jobLockWarned?: boolean;
};
const slot = (g.__restoreJob ??= { current: null });

export const activeRestore = (): ActiveRestore | null => slot.current;

export function setActiveRestore(r: ActiveRestore | null) {
  slot.current = r;
}

// ── Taking new jobs ───────────────────────────────────────────────────────────

/**
 * When this worker's run started: CONSOLE_WORKER_JOB_STARTED_AT (ms since 1970, set by worker.yml at
 * the start of the GitHub Actions job and by scripts/worker.mjs), else when this process started.
 */
const clock = (g.__workerClock ??= { startedAt: Number(process.env.CONSOLE_WORKER_JOB_STARTED_AT) || Date.now(), retiring: null });
export const workerStartedAt = () => clock.startedAt;
/** New backups and restore applies are taken until this long after the run started. 0: always. */
const acceptMs = () => (Number(process.env.CONSOLE_WORKER_ACCEPT_MINUTES) || 0) * 60_000;

/** The worker is stopping (and a new one takes over): no new backups or applies from now on. */
export function stopTakingJobs(why: string) {
  clock.retiring ??= why;
}

/**
 * Why this worker takes no new backup or restore apply right now, or null when it does. Close to
 * GitHub's 6-hour limit a job could be cut off half-way, so it is left to the next worker.
 */
export function jobsPaused(): string | null {
  const ms = acceptMs();
  if (!clock.retiring && ms > 0 && Date.now() - clock.startedAt > ms) stopTakingJobs('close to its time limit');
  if (!clock.retiring) return null;
  return 'The worker is about to restart (its GitHub Actions run is close to the 6-hour limit), so it starts no new backups or restore applies. A fresh worker takes over in a minute or two — try again then.';
}

// ── Writes to wait for before the process exits ───────────────────────────────

const writes = (g.__jobWrites ??= new Set());

/** A database write a finished job still has in flight (run status, logs): the worker waits for it before it exits. */
export function trackWrite<T>(p: Promise<T>): Promise<T> {
  writes.add(p);
  void p.then(() => writes.delete(p), () => writes.delete(p));
  return p;
}

/** Waits (at most `timeoutMs`) for the tracked writes, including ones started meanwhile. */
export async function settleWrites(timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (writes.size && Date.now() < until) {
    await Promise.race([Promise.allSettled([...writes]), new Promise((r) => setTimeout(r, Math.max(0, until - Date.now())))]);
  }
}

// ── The same lock across workers (Supabase) ───────────────────────────────────

/** Rows last this long without a renewal (a worker that died gives them up by then). */
const LOCK_TTL_S = 10 * 60;
const RENEW_MS = 2 * 60_000;

/** This process, as the holder of a lock row (no secrets: host, pid, random). */
const lockOwner = () => (g.__jobLockOwner ??= `${process.env.CONSOLE_WORKER_ID?.trim() || os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`);

export class LockBusy extends Error {
  status = 409;
}

/** Locks held in Supabase for one job: renewed while it runs, given back by release(). */
export interface SharedLock {
  keys: string[];
  release(): Promise<void>;
}

/** The function or table is not there (migration 0013 not applied yet). */
export const missingFn = (e: { code?: string; message?: string }) => /^(PGRST202|42883|PGRST205|42P01)$/.test(e.code ?? '') || /Could not find the function/.test(e.message ?? '');

type AcquireRow = { acquired: boolean; holder: string; holder_what: string; held_until: string };
const releasing = new Map<string, Promise<void>>();

/**
 * Takes the lock rows for `keys` (e.g. cf-account:<id>), all or none. Throws LockBusy when another
 * worker holds one. Without Supabase, or before migration 0013 is applied, there is only the
 * in-process lock: returns a lock that does nothing (logged once).
 */
export async function acquireShared(keys: string[], what: string): Promise<SharedLock> {
  const want = [...new Set(keys.filter(Boolean))];
  const none: SharedLock = { keys: [], release: async () => {} };
  if (!want.length || !isConfigured()) return none;
  const owner = lockOwner();
  const held: string[] = [];
  // A release of the same key still on its way would otherwise land after this acquire and delete it.
  await Promise.all(want.map((key) => releasing.get(key)));
  const giveBack = async () => {
    await Promise.all(held.map((key) => {
      const p = Promise.resolve(db().rpc('job_lock_release', { p_key: key, p_owner: owner })).then(() => {}, () => {});
      releasing.set(key, p);
      void p.then(() => { if (releasing.get(key) === p) releasing.delete(key); });
      return p;
    }));
  };
  for (const key of want) {
    const { data, error } = await db().rpc('job_lock_acquire', { p_key: key, p_owner: owner, p_ttl_seconds: LOCK_TTL_S, p_what: what.slice(0, 300) });
    if (error) {
      if (missingFn(error)) {
        if (!g.__jobLockWarned) { g.__jobLockWarned = true; console.warn('[lock] public.job_locks is missing (run supabase/migrations/0013_worker_locks.sql): jobs are locked on this worker only'); }
        await giveBack();
        return none;
      }
      await giveBack();
      throw new LockBusy(`Could not check whether another worker runs a job for this account: ${error.message}`);
    }
    const row = (Array.isArray(data) ? data[0] : data) as AcquireRow | undefined;
    if (!row?.acquired) {
      await giveBack();
      const until = row?.held_until ? ` (its lock runs out by ${new Date(row.held_until).toISOString().slice(11, 16)} UTC if that worker stopped)` : '';
      throw new LockBusy(`Another worker is running a job for this Cloudflare account${row?.holder_what ? ` — ${row.holder_what}` : ''}. Wait for it to finish${until}`);
    }
    held.push(key);
  }
  const timer = setInterval(() => {
    for (const key of held) {
      void db().rpc('job_lock_renew', { p_key: key, p_owner: owner, p_ttl_seconds: LOCK_TTL_S }).then(({ data, error }) => {
        const row = (Array.isArray(data) ? data[0] : data) as { renewed?: boolean } | undefined;
        if (error) console.error(`[lock] renewing ${key} failed: ${error.message}`);
        else if (row && row.renewed === false) console.error(`[lock] ${key} is no longer held by this worker (it ran out) — another worker may start a job for it`);
      }, (err) => console.error(`[lock] renewing ${key} failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }, RENEW_MS);
  timer.unref?.();
  let released = false;
  return {
    keys: held,
    release: () => {
      if (released) return Promise.resolve();
      released = true;
      clearInterval(timer);
      return trackWrite(giveBack());
    },
  };
}
