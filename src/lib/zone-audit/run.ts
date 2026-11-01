import 'server-only';
import { randomUUID } from 'node:crypto';
import { tokenForAccount, tokenForZone } from '../account-token';
import { HttpError } from '../http';
import { listZones } from '../zone-explorer';
import { auditZone } from './read';
import { finishAudit, getAudit, startAudit } from './store';
import type { AccountAuditView, Severity } from './types';

// Runs one audit in the background on the worker (route() relays the start from the web role): the
// start answers once the audit is done or after WAIT_MS, whichever is first; the page then asks for
// the stored audit every few seconds while it runs, and stops. At most MAX_RUNNING audits run at once
// per worker, each stopped after RUN_LIMIT_MS (its row then says so).
//
// An account audit queues every zone of the account a stored credential reads and audits them
// BATCH_SLOTS at a time (one slot stays free for single audits). One account audit runs at a time;
// its progress is kept in the worker's memory (each zone's audit is stored as usual), so a worker
// restart ends it — the zones audited so far keep their reports.

const WAIT_MS = 8_000;
export const MAX_RUNNING = 3;
const BATCH_SLOTS = 2;
const RUN_LIMIT_MS = 10 * 60_000;
/** Failed and skipped zones listed in the account audit's progress (the counts cover all of them). */
const PROBLEMS_SHOWN = 50;

interface Zone { zoneId: string; zoneName: string; accountId: string; accountName: string; token: string }
interface Batch extends Omit<AccountAuditView, 'running' | 'queued'> { queue: { id: string; name: string }[]; active: Set<string>; stop: boolean }

const g = globalThis as unknown as { __zoneAudits?: Set<string>; __accountAudit?: Batch | null };
const running = (g.__zoneAudits ??= new Set());

/** Starts the stored row and the audit; `done` settles when the report (or the error) is stored. */
async function launch(z: Zone, hours: number, by: string | null) {
  const row = await startAudit({ zoneId: z.zoneId, zoneName: z.zoneName, accountId: z.accountId }, by, hours);
  if (!row) throw new HttpError(409, 'An audit of this zone is running — wait for it to finish');
  running.add(row.id);
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Error('The audit took longer than 10 minutes and was stopped')), RUN_LIMIT_MS);
  timer.unref?.();
  const done = auditZone({ token: z.token, zoneId: z.zoneId, zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName, hours, signal: stop.signal })
    .then(async (report) => { await finishAudit(row.id, { report }); return report.summary.worst; })
    .catch(async (err) => { await finishAudit(row.id, { error: stop.signal.aborted ? String((stop.signal.reason as Error)?.message ?? 'Stopped') : err instanceof Error ? err.message : String(err) }).catch(() => {}); throw err; })
    .finally(() => { clearTimeout(timer); running.delete(row.id); });
  return { row, done };
}

export async function runAudit(zoneId: string, hours: number, by: string | null) {
  if (running.size >= MAX_RUNNING) throw new HttpError(429, `${MAX_RUNNING} audits are running already — try again in a minute`, { 'Retry-After': '60' });
  const z = await tokenForZone(zoneId);
  const { row, done } = await launch({ zoneId, ...z }, hours, by);
  await Promise.race([done.catch(() => {}), new Promise((resolve) => setTimeout(resolve, WAIT_MS).unref?.())]);
  return (await getAudit(row.id).then((a) => (a ? { ...a, report: null } : null))) ?? row;
}

// ── Every zone of an account ────────────────────────────────────────────────

/** The account audit running now, or the last one (until the worker restarts). */
export function accountAudit(): AccountAuditView | null {
  const b = g.__accountAudit;
  if (!b) return null;
  const { queue, active, stop: _stop, ...view } = b;
  return { ...view, running: active.size, queued: queue.length, problems: view.problems.slice(0, PROBLEMS_SHOWN) };
}

export async function startAccountAudit(accountId: string, hours: number, by: string | null): Promise<AccountAuditView> {
  if (g.__accountAudit?.state === 'running') throw new HttpError(409, `An audit of every zone in ${g.__accountAudit.accountName} is running — wait for it to finish or stop it`);
  const list = await listZones();
  const zones = list.zones.filter((z) => z.accountId === accountId && list.credentialOf[z.id]).sort((a, b) => a.name.localeCompare(b.name));
  if (!zones.length) throw new HttpError(404, 'No stored credential reads a zone in that account');
  // One token for the account when a credential reads it; else each zone's own (looked up as it starts).
  const accountToken = await tokenForAccount(accountId).catch(() => '');
  const b: Batch = {
    id: randomUUID(), accountId, accountName: zones[0].accountName || accountId, hours, startedBy: by, startedAt: new Date().toISOString(), finishedAt: null,
    state: 'running', total: zones.length, ready: 0, failed: 0, skipped: 0, worst: {}, problems: [],
    queue: zones.map((z) => ({ id: z.id, name: z.name })), active: new Set(), stop: false,
  };
  g.__accountAudit = b;
  void drive(b, accountToken);
  return accountAudit()!;
}

/** Stops an account audit: no further zone starts; the ones running finish. */
export function stopAccountAudit(): AccountAuditView | null {
  const b = g.__accountAudit;
  if (!b || b.state !== 'running') throw new HttpError(409, 'No account audit is running');
  b.stop = true;
  b.queue.length = 0;
  if (!b.active.size) settle(b);
  return accountAudit();
}

function settle(b: Batch) {
  if (b.state !== 'running') return;
  b.state = b.stop ? 'stopped' : 'finished';
  b.finishedAt = new Date().toISOString();
}

const problem = (b: Batch, z: { id: string; name: string }, kind: 'failed' | 'skipped', reason: string) => {
  b[kind]++;
  if (b.problems.length < 500) b.problems.push({ zoneId: z.id, zoneName: z.name, kind, reason: reason.slice(0, 300) });
};

async function drive(b: Batch, accountToken: string) {
  const one = async (z: { id: string; name: string }) => {
    b.active.add(z.id);
    try {
      const token = accountToken || (await tokenForZone(z.id)).token;
      const { done } = await launch({ zoneId: z.id, zoneName: z.name, accountId: b.accountId, accountName: b.accountName, token }, b.hours, b.startedBy);
      const worst = await done;
      b.ready++;
      const key = (worst ?? 'none') as Severity | 'none';
      b.worst[key] = (b.worst[key] ?? 0) + 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof HttpError && err.status === 409) problem(b, z, 'skipped', msg);
      else problem(b, z, 'failed', msg);
    } finally {
      b.active.delete(z.id);
    }
  };
  const lane = async () => {
    while (!b.stop && b.queue.length) {
      // Single audits share the worker's limit: wait for a free slot rather than refusing.
      if (running.size >= MAX_RUNNING) { await new Promise((r) => setTimeout(r, 2_000).unref?.()); continue; }
      await one(b.queue.shift()!);
    }
  };
  await Promise.all(Array.from({ length: BATCH_SLOTS }, lane));
  settle(b);
}

