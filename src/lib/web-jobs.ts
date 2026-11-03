import 'server-only';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { after } from 'next/server';
import { db } from './supabase';
import { HttpError } from './http';
import { openRelay, sealRelay, VaultError } from './vault';
import { UseWorker } from './worker-link';
import type { BackgroundOptions, Pending, Progress } from './bg-job';

// bg-job.ts on the web side (Vercel): the request after a 202 may reach another instance, so a long
// read's progress and result are kept in Supabase (web_jobs, supabase/migrations/0023_web_shared_reads.sql)
// instead of this process's memory. The read itself runs on the instance that started it, kept alive
// by after() until it finishes; every instance answers its polls from the row. The same rules as in
// memory: a request joins the read that runs for its key; a finished read goes to the polls that name
// its job (with keepMs) or, without keepMs, to any request for SHARE_MS unless it asks for fresh data;
// a read nobody asks about for abandonMs is stopped. A read that would outlast Vercel's function
// limit is stopped at MAX_RUN_MS and sent to the worker (UseWorker), as is every read when the
// table is missing.

/** A running row whose heartbeat is older than this has lost its server (stopped or ended). */
const STALE_MS = 45_000;
/** How often the running read writes its progress (its heartbeat). */
const BEAT_MS = 3_000;
/** How often a request waiting for another instance's read looks at the row. */
const LOOK_MS = 500;
/** Without keepMs: how long a finished read is handed to any request (the reads' own cache time). */
const SHARE_MS = 10 * 60_000;
/** After a read was too long here, the same read goes to the worker for this long. */
const TOO_LONG_FOR_MS = 60 * 60_000;
/** Stops a read before Vercel's 300 s function limit (vercel.json), leaving time to record it. */
const maxRunMs = () => Math.max(1, Number(process.env.WEB_JOB_MAX_MS) || 270_000);

interface Sealed { iv: string; tag: string; ct: string }
interface Row {
  key: string; job: string; status: 'running' | 'done' | 'failed'; done: number; total: number; note: string | null;
  started_at: string; updated_at: string; asked_at: string; keep_until: string | null; result: Sealed | null;
  error_status: number | null; error: string | null; error_code: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');
const aad = (k: string, job: string) => `web-job:${k}:${job}`;
const missing = (e: { code?: string; message?: string }) => /^(PGRST202|PGRST205|42883|42P01)$/.test(e.code ?? '') || /does not exist|schema cache|Could not find the function/i.test(e.message ?? '');
const NOT_SET_UP = 'Long reads run on the worker until supabase/migrations/0023_web_shared_reads.sql is applied';

/** Reads this process runs, so its own polls don't need the table. */
const g = globalThis as unknown as { __webJobs?: Map<string, { job: string; p: Promise<unknown> }> };
const local = (g.__webJobs ??= new Map());

async function rowOf(k: string): Promise<Row | null> {
  const { data, error } = await db().from('web_jobs').select('*').eq('key', k).maybeSingle();
  if (error) throw missing(error) ? new UseWorker(NOT_SET_UP) : new HttpError(503, `Could not read the progress of this read: ${error.message}`);
  return data as Row | null;
}

const pendingOf = (r: Row): Pending => ({ pending: true, job: r.job, done: r.done, total: r.total, startedAt: r.started_at, ...(r.note ? { note: r.note } : {}) });
const stale = (r: Row) => Date.now() - Date.parse(r.updated_at) > STALE_MS;

async function resultOf<T>(r: Row): Promise<T> {
  if (!r.result) throw new HttpError(502, 'The read finished without a result');
  return JSON.parse(zlib.gunzipSync(await openRelay(r.result, aad(r.key, r.job))).toString('utf8')) as T;
}
function failure(r: Row): Error {
  if (r.error_code === 'too_long') return new UseWorker(r.error ?? 'Too long for the web side');
  return new HttpError(r.error_status ?? 502, r.error ?? 'The read failed');
}

/** Waits up to waitMs for a read that runs (here or on another instance): its result, or how far it got. */
async function follow<T>(k: string, r: Row, waitMs: number): Promise<T | Pending> {
  void db().from('web_jobs').update({ asked_at: new Date().toISOString() }).eq('key', k).eq('job', r.job).then(() => {}, () => {});
  const until = Date.now() + waitMs;
  let cur: Row | null = r;
  const mine = local.get(k);
  if (mine?.job === r.job) {
    // Run here: wait for it in memory, then read what it recorded.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = await Promise.race([mine.p.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), waitMs); })]).finally(() => clearTimeout(timer));
    cur = await rowOf(k);
    if (!ended) return pendingOf(cur?.job === r.job ? cur : r);
  }
  for (;;) {
    if (!cur || cur.job !== r.job) return pendingOf(r); // replaced: the next poll joins the new read
    if (cur.status === 'done') return resultOf<T>(cur);
    if (cur.status === 'failed') throw failure(cur);
    if (Date.now() >= until) return pendingOf(cur);
    await sleep(Math.min(LOOK_MS, Math.max(0, until - Date.now())));
    cur = await rowOf(k);
  }
}

export async function sharedBackground<T>(key: string, build: (progress: Progress) => Promise<T>, waitMs: number, opts: BackgroundOptions): Promise<T | Pending> {
  const k = hashKey(key);
  const r = await rowOf(k);
  if (r) {
    if (r.job === opts.join) {
      if (r.status !== 'running' || !stale(r)) return follow<T>(k, r, waitMs);
    } else if (r.status === 'running' && !stale(r)) {
      return follow<T>(k, r, waitMs);
    } else if (r.status === 'done' && !opts.keepMs && !opts.fresh && r.keep_until && Date.parse(r.keep_until) > Date.now()) {
      return resultOf<T>(r);
    } else if (r.status === 'failed' && r.error_code === 'too_long' && Date.now() - Date.parse(r.updated_at) < TOO_LONG_FOR_MS) {
      throw failure(r);
    }
  }
  const job = crypto.randomUUID();
  const { data, error } = await db().rpc('web_job_claim', { p_key: k, p_job: job, p_stale_ms: STALE_MS });
  if (error) throw missing(error) ? new UseWorker(NOT_SET_UP) : new HttpError(503, `Could not start this read: ${error.message}`);
  const claimed = ((data ?? []) as Row[])[0];
  if (!claimed) throw new HttpError(503, 'Could not start this read');
  if (claimed.job !== job) return follow<T>(k, claimed, waitMs); // another instance started it first
  start(k, job, build, opts);
  return follow<T>(k, claimed, waitMs);
}

/** Runs the read here, writing its progress, then its result or failure, to the row. */
function start<T>(k: string, job: string, build: (progress: Progress) => Promise<T>, opts: BackgroundOptions) {
  const stop = new AbortController();
  const progress: Progress = { done: 0, total: 0, signal: stop.signal };
  let tooLong = false;
  const deadline = setTimeout(() => { tooLong = true; stop.abort(new Error('This read takes longer than the web side allows')); }, maxRunMs());
  const beat = setInterval(() => {
    void (async () => {
      const { data } = await db().from('web_jobs')
        .update({ done: progress.done, total: progress.total, note: progress.note?.slice(0, 500) ?? null, updated_at: new Date().toISOString() })
        .eq('key', k).eq('job', job).select('asked_at').maybeSingle();
      // Replaced by a newer read, or nobody has asked for it for abandonMs: stop.
      if (!data) stop.abort(new Error('Replaced by a newer read'));
      else if (opts.abandonMs && Date.now() - Date.parse((data as { asked_at: string }).asked_at) > opts.abandonMs) stop.abort(new Error('Nobody waits for this read any more'));
    })().catch(() => { /* the next beat tries again */ });
  }, BEAT_MS);
  const p = (async () => {
    try {
      const value = await build(progress);
      if (tooLong) throw new Error('too long');
      const sealed = await sealRelay(zlib.gzipSync(Buffer.from(JSON.stringify(value))), aad(k, job));
      const keep = opts.keepMs ?? SHARE_MS;
      await db().from('web_jobs').update({ status: 'done', done: progress.done, total: progress.total, result: sealed, keep_until: new Date(Date.now() + keep).toISOString(), updated_at: new Date().toISOString() }).eq('key', k).eq('job', job);
    } catch (err) {
      const known = err instanceof HttpError || err instanceof VaultError;
      if (!known && !tooLong) console.error('[web-jobs] a read failed:', err);
      await db().from('web_jobs').update({
        status: 'failed', updated_at: new Date().toISOString(),
        error_status: tooLong ? 503 : known ? (err as HttpError).status : 502,
        error: (tooLong ? 'This read takes longer than the web side allows: it runs on the worker' : known ? (err as Error).message : 'The read from Cloudflare failed — see the server log').slice(0, 2000),
        error_code: tooLong ? 'too_long' : null,
      }).eq('key', k).eq('job', job);
    } finally {
      clearTimeout(deadline);
      clearInterval(beat);
      if (local.get(k)?.job === job) local.delete(k);
    }
  })();
  local.set(k, { job, p });
  // Keeps the function alive until the read is recorded; outside a request (tests) it just runs.
  try { after(() => p); } catch { /* not in a request */ }
}
