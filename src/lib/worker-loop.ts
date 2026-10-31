import 'server-only';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, missingEnv } from './supabase';
import { DATA_DIR, ensureDir } from './store';
import { ensureTools, toolStatus } from './tools';
import { activeRunId } from './runner';
import { activeRestore, jobsPaused, settleWrites, stopTakingJobs, workerStartedAt } from './job-lock';
import { liveRestoreIds } from './restore';
import { openRelay, sealRelay } from './vault';
import { RELAY_CHUNK, RELAY_HEADER, passiveCall, type RelayRequest, type RelayResponse } from './worker-link';
import { localRequestHeaders } from './hosts';

// The worker: started inside `npm run worker` (src/instrumentation.ts). It announces itself in
// public.workers, keeps Terraform and cf-terraforming installed, and takes the calls the web side
// (Vercel) queues in public.worker_calls: each is replayed on this server over loopback, with the
// caller's identity signed, so it runs exactly as if it had been sent here, from this machine's IP.

const HEARTBEAT_MS = 5_000;
const IP_REFRESH_MS = 10 * 60_000;
const MAX_PARALLEL = 8;
/**
 * On GitHub Actions: stop after this long with nothing to do, and before the 6-hour job limit
 * (counted from the start of the run: CONSOLE_WORKER_JOB_STARTED_AT). 0: never. From
 * CONSOLE_WORKER_ACCEPT_MINUTES on it starts no new backups or applies (job-lock.ts jobsPaused) and
 * stops as soon as nothing runs, so the next worker takes over.
 */
const IDLE_MS = (Number(process.env.CONSOLE_WORKER_IDLE_MINUTES) || 0) * 60_000;
const MAX_MS = (Number(process.env.CONSOLE_WORKER_MAX_MINUTES) || 0) * 60_000;
/** A backup or restore is running, a restore session is open (its plan and held key live in memory), or monitoring checks are running or due. */
const jobBusy = () => !!activeRunId() || !!activeRestore() || liveRestoreIds().size > 0;
const busy = () => jobBusy() || monitoringBusy() || reportsBusy();
/** The monitoring queue's state on globalThis (src/lib/monitor-queue.ts), read without importing it. */
const monitoringBusy = () => { const m = (globalThis as unknown as { __monitorQueue?: { running: Map<string, unknown>; due: number } }).__monitorQueue; return !!m && (m.running.size > 0 || m.due > 0); };
/** Scheduled reports being made (src/lib/report-scheduler.ts), read the same way. */
const reportsBusy = () => ((globalThis as unknown as { __reports?: { running: Set<string> } }).__reports?.running.size ?? 0) > 0;
const ANSWER_HEADERS = ['content-type', 'content-disposition', 'retry-after', 'cache-control'];

const g = globalThis as unknown as {
  __workerLoop?: boolean; __outdated?: string; __workerTimers?: { beat: ReturnType<typeof setInterval>; purge: ReturnType<typeof setInterval> };
  /** The calls this process holds (taken, waiting for a slot, or running): handed back or failed when it is stopped. */
  __workerCalls?: { id: string | null; waiting: { id: string }[]; running: Set<string> };
  __workerStopping?: boolean;
};
const held = (g.__workerCalls ??= { id: null, waiting: [], running: new Set<string>() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = () => Number(process.env.PORT) || 4400;
const base = () => `http://127.0.0.1:${port()}`;
const log = (msg: string) => console.log(`[worker] ${msg}`);

/** A stable id: CONSOLE_WORKER_ID (containers, whose disk is fresh on every start), else one kept in the data folder. */
function workerId(): string {
  const fixed = process.env.CONSOLE_WORKER_ID?.trim();
  if (fixed) return fixed;
  const file = path.join(DATA_DIR, 'worker-id');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* first start */ }
  ensureDir(DATA_DIR);
  const id = `${os.hostname()}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(file, id, { mode: 0o600 });
  return id;
}

/** This machine's public IP, as Cloudflare sees it (the IP to allow on IP-restricted tokens). */
async function publicIp(): Promise<string | null> {
  try {
    const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(5_000), cache: 'no-store' });
    return /^ip=(.+)$/m.exec(await res.text())?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export function startWorkerLoop() {
  if (g.__workerLoop) return;
  g.__workerLoop = true;
  // GitHub Actions cancels or times out a run with SIGINT / SIGTERM (scripts/worker.mjs sets
  // NEXT_MANUAL_SIG_HANDLE, so these are handled here): hand back the calls, then stop.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { void shutdown(sig); });
  void keepRunning();
  // Monitoring: the queue runs what is due whenever this worker is up (src/lib/monitor-queue.ts).
  void import('./monitor-queue').then((m) => m.startQueue()).catch((err) => log(`monitoring: the queue could not start (${err instanceof Error ? err.message : String(err)})`));
  // Scheduled reports: due ones are made and sent by one worker (src/lib/report-scheduler.ts).
  void import('./report-scheduler').then((m) => m.startReportScheduler()).catch((err) => log(`reports: the schedule could not start (${err instanceof Error ? err.message : String(err)})`));
}

/** Runs the worker; if anything stops it, logs why and starts it again (a dead loop would leave the worker "offline" for good). */
async function keepRunning() {
  for (let attempt = 0; ; attempt++) {
    try {
      await run();
    } catch (err) {
      const wait = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
      console.error(`[worker] stopped (${err instanceof Error ? err.message : String(err)}); starting again in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
  }
}

async function run() {
  const missing = missingEnv();
  // Without Supabase there is nothing to take calls from: say so (every minute), then wait for settings.
  if (missing.length) throw new Error(`not configured: set ${missing.join(', ')} for the worker (on Cloudflare: the Worker's Variables and Secrets, then redeploy)`);
  const id = workerId();
  const startedAt = new Date().toISOString();
  let ip: string | null = null;
  let ipAt = 0;
  let tools: { name: string; version: string | null }[] = [];
  // The git commit on GitHub Actions (or CONSOLE_VERSION), else package.json: the web side compares it with its own.
  const version = process.env.GITHUB_SHA?.trim() || process.env.CONSOLE_VERSION?.trim() || (() => { try { return (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: string }).version ?? null; } catch { return null; } })();

  let first = true;
  const beat = async () => {
    if (Date.now() - ipAt > IP_REFRESH_MS) { ip = (await publicIp()) ?? ip; ipAt = Date.now(); }
    const { error } = await db().from('workers').upsert({
      id, hostname: os.hostname(), public_ip: ip, version, platform: `${process.platform} ${os.release()}`, tools, started_at: startedAt, last_seen: new Date().toISOString(),
      // A fresh worker starts without the stop request meant for the one before it.
      ...(first ? { retire_requested: null } : {}),
    });
    first = false;
    if (!error) {
      const own = await db().from('workers').select('retire_requested').eq('id', id).maybeSingle();
      const wanted = (own.data as { retire_requested: string | null } | null)?.retire_requested;
      if (wanted && wanted !== version && !g.__outdated) { g.__outdated = wanted; log(`a newer version of the console is deployed (${wanted.slice(0, 7)}): stopping once nothing is running`); }
    }
    if (error) log(`heartbeat failed: ${error.message}${/workers|42P01|PGRST205/.test(`${error.code} ${error.message}`) ? ' (run supabase/migrations/0004_worker.sql)' : ''}`);
  };

  // Wait for this server to answer before replaying calls on it.
  for (let i = 0; i < 120; i++) {
    try { await fetch(`${base()}/console/login`, { signal: AbortSignal.timeout(2_000) }); break; } catch { await sleep(500); }
  }
  await beat();
  log(`${id} online at ${base()}${ip ? `, public IP ${ip}` : ''}`);
  // One heartbeat and one purge timer for the life of the process (run() may start again).
  if (g.__workerTimers) clearInterval(g.__workerTimers.beat), clearInterval(g.__workerTimers.purge);
  g.__workerTimers = {
    beat: setInterval(() => { void beat().catch((err) => log(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`)); }, HEARTBEAT_MS),
    purge: setInterval(() => { void purge().catch(() => {}); }, 60_000),
  };

  // Terraform and cf-terraforming: downloaded (checksum-verified) when missing.
  void (async () => {
    try {
      await ensureTools((line) => log(line));
    } catch (err) {
      log(`tools: ${err instanceof Error ? err.message : String(err)}`);
    }
    tools = (await toolStatus().catch(() => [])).map((t) => ({ name: t.name, version: t.version ?? null }));
    await beat().catch(() => {});
  })();

  held.id = id;
  let inflight = 0;
  /** Calls running now that count as work (not status polls: passiveCall). */
  let working = 0;
  let lastWork = Date.now();
  // Claimed calls waiting for one of the MAX_PARALLEL slots (kept if run() starts again).
  const waiting = held.waiting as { id: string; request: never }[];
  const next = () => {
    while (inflight < MAX_PARALLEL && waiting.length && !g.__workerStopping) {
      const row = waiting.shift()!;
      inflight++;
      held.running.add(row.id);
      let counted = false;
      const onWork = () => { counted = true; working++; lastWork = Date.now(); };
      void handle(row.id, row.request, onWork).finally(() => {
        inflight--;
        held.running.delete(row.id);
        if (counted) { working--; lastWork = Date.now(); }
        next();
      });
    }
  };
  // Woken at once when the web side queues a call (Supabase Realtime), instead of at the next poll.
  let kick: (() => void) | null = null;
  const nap = (ms: number) => new Promise<void>((resolve) => {
    const done = () => { clearTimeout(t); kick = null; resolve(); };
    const t = setTimeout(done, ms);
    kick = done;
  });
  listenForCalls(() => kick?.());
  // Supabase unreachable or answering 5xx (often an HTML gateway page): one short line, then every
  // 10th failure, waiting longer each time (2 s up to 30 s); a line again once it answers.
  let failures = 0;
  const queueFailed = async (raw: string) => {
    failures++;
    if (failures === 1 || failures % 10 === 0) log(`queue: Supabase did not answer (${brief(raw)})${failures > 1 ? ` — ${failures} times in a row, still retrying` : ', retrying'}`);
    await sleep(Math.min(2_000 * 2 ** Math.min(failures - 1, 4), 30_000));
  };
  for (;;) {
    // Stopping (SIGTERM): no new calls are taken.
    if (g.__workerStopping) { await sleep(1_000); continue; }
    let took = 0;
    try {
      if (inflight + waiting.length < MAX_PARALLEL) {
        // Every queued call claimed in one request: only rows still queued change, so a second worker
        // never takes the same call. More than MAX_PARALLEL wait here for a free slot.
        const now = new Date().toISOString();
        const { data, error } = await db().from('worker_calls').update({ status: 'running', worker_id: id, claimed_at: now })
          .eq('status', 'queued').gt('expires_at', now).select('id, request, created_at');
        if (error) { await queueFailed(error.message); continue; }
        if (failures) { log(`queue: Supabase answers again after ${failures} failed ${failures === 1 ? 'try' : 'tries'}`); failures = 0; }
        const rows = ((data ?? []) as { id: string; request: never; created_at: string }[]).sort((a, b) => a.created_at.localeCompare(b.created_at));
        took = rows.length;
        waiting.push(...rows.map((r) => ({ id: r.id, request: r.request })));
        next();
      }
    } catch (err) {
      // A dropped connection to Supabase: keep going.
      await queueFailed(err instanceof Error ? err.message : String(err));
      continue;
    }
    // Status polls and health checks are answered but are not work: only other calls, and a backup or
    // restore (idle counts from when it ended), keep it up. Monitoring only delays the stop (busy()).
    if (working || jobBusy()) lastWork = Date.now();
    const idle = IDLE_MS > 0 && Date.now() - lastWork > IDLE_MS;
    const old = MAX_MS > 0 && Date.now() - workerStartedAt() > MAX_MS;
    // Close to GitHub's 6-hour limit: no new backups or applies (jobsPaused), and stop once nothing runs.
    const draining = !!jobsPaused();
    if ((idle || old || draining || g.__outdated) && !inflight && !waiting.length && !busy()) {
      await retire(id, g.__outdated ? 'a newer version of the console is deployed' : old || draining ? `close to the time limit of its run (${Math.round((Date.now() - workerStartedAt()) / 60_000)} minutes in)` : `idle for ${Math.round(IDLE_MS / 60_000)} minutes`);
      await finishWrites();
      process.exit(0);
    }
    // Quick to pick up while busy, gentler on Supabase when idle; a new call (Realtime) ends the wait at once.
    await nap(took ? 50 : Date.now() - lastWork < 30_000 ? 100 : 250);
  }
}

/**
 * Supabase Realtime: a new row in worker_calls wakes the loop at once. Needs the table in the
 * supabase_realtime publication (supabase/migrations/0009_worker_calls_realtime.sql); without it,
 * or when the websocket cannot connect, nothing changes: the loop keeps polling.
 */
function listenForCalls(wake: () => void) {
  // One subscription per process (run() may start again): a new run only swaps the function it wakes.
  const gl = globalThis as unknown as { __callsListener?: { wake: () => void } };
  if (gl.__callsListener) { gl.__callsListener.wake = wake; return; }
  const listener = (gl.__callsListener = { wake });
  let said = '';
  const say = (msg: string) => { if (said !== msg) { said = msg; log(msg); } };
  try {
    db().channel('worker-calls')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'worker_calls' }, () => listener.wake())
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') say('queue: Supabase Realtime connected — calls are picked up as soon as they are queued');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') say(`queue: Supabase Realtime not available (${err?.message ?? status.toLowerCase()}) — polling instead`);
      });
  } catch (err) {
    say(`queue: Supabase Realtime not available (${err instanceof Error ? err.message : String(err)}) — polling instead`);
  }
}

/** An error in one line: an HTML error page becomes its title ("502 Bad Gateway"). */
function brief(message: string) {
  const title = /<title>([^<]*)<\/title>/i.exec(message)?.[1] ?? /<h1>([^<]*)<\/h1>/i.exec(message)?.[1];
  return (title ?? message).replace(/\s+/g, ' ').trim().slice(0, 200) || 'no answer';
}

const aadFor = (id: string, part = 'request') => `worker-call:${id}:${part}`;

/** Runs one call; `onWork` is called when it is one that counts as work (not a status poll). */
async function handle(callId: string, sealed: never, onWork: () => void) {
  try {
    const r = JSON.parse((await openRelay(sealed, aadFor(callId))).toString('utf8')) as RelayRequest;
    if (!passiveCall(r)) onWork();
    const res = await fetch(`${base()}${r.path}`, {
      method: r.method,
      headers: { ...r.headers, [RELAY_HEADER]: r.identity, ...localRequestHeaders(), ...(r.method !== 'GET' && r.method !== 'HEAD' ? { origin: base() } : {}) },
      body: r.body ? new Uint8Array(Buffer.from(r.body, 'base64')) : undefined,
      redirect: 'manual',
      cache: 'no-store',
    });
    let headers: Record<string, string> = {};
    for (const h of ANSWER_HEADERS) { const v = res.headers.get(h); if (v) headers[h] = v; }
    let body = Buffer.from(await res.arrayBuffer());
    let status = res.status;
    // An API route this build does not have (Next.js answers its HTML 404; the routes answer JSON):
    // the console was updated after this worker started. Say so, and stop once nothing is running
    // so the next request starts a worker with the new code.
    if (status === 404 && r.path.startsWith('/api/') && !(res.headers.get('content-type') ?? '').includes('application/json')) {
      if (!g.__outdated) { g.__outdated = 'route missing'; log(`${r.path.split('?')[0]} is not in this build: the console is newer — stopping once nothing is running`); }
      status = 503;
      headers = { 'content-type': 'application/json', 'retry-after': '120' };
      body = Buffer.from(JSON.stringify({ error: 'The worker that is running started before the console was updated and does not have this feature yet. It restarts with the new version as soon as it has finished what it is doing (a running backup or an open restore keeps it busy) — try again in a few minutes, or cancel its run in GitHub › Actions › Console worker.' }));
    }
    const answer: RelayResponse = { status, headers };
    let chunks = 0;
    if (body.length <= RELAY_CHUNK) {
      if (body.length) answer.body = body.toString('base64');
    } else {
      for (let off = 0; off < body.length; off += RELAY_CHUNK, chunks++) {
        const part = await sealRelay(body.subarray(off, off + RELAY_CHUNK), aadFor(callId, `chunk:${chunks}`));
        const ins = await db().from('worker_call_chunks').insert({ call_id: callId, seq: chunks, data: part });
        if (ins.error) throw new Error(`saving the answer: ${ins.error.message}`);
      }
    }
    const response = await sealRelay(Buffer.from(JSON.stringify(answer)), aadFor(callId, 'response'));
    await db().from('worker_calls').update({ status: 'done', response, chunks, done_at: new Date().toISOString() }).eq('id', callId);
  } catch (err) {
    await db().from('worker_calls').update({ status: 'failed', error: err instanceof Error ? err.message : String(err), done_at: new Date().toISOString() }).eq('id', callId);
  }
}

/** Stops announcing itself and marks itself offline, so the web side starts a new worker when needed. */
async function retire(id: string, why: string) {
  stopTakingJobs(why);
  if (g.__workerTimers) { clearInterval(g.__workerTimers.beat); clearInterval(g.__workerTimers.purge); }
  await db().from('workers').update({ last_seen: new Date(Date.now() - 3_600_000).toISOString() }).eq('id', id);
  log(`stopping: ${why}. The next visit to the console starts it again.`);
}

/**
 * Before the process exits: the monitoring queue's running units, the writes jobs left in flight
 * (run status and logs: job-lock.ts trackWrite, lock rows) and the records being copied to
 * Supabase (state-mirror.ts) — each waited for, within a time limit.
 */
async function finishWrites(timeoutMs = 25_000) {
  const until = Date.now() + timeoutMs;
  const left = () => Math.max(1_000, until - Date.now());
  const within = (p: Promise<unknown>) => Promise.race([p.catch(() => {}), sleep(left())]);
  await within(import('./monitor-queue').then((m) => {
    const q = m as { stopQueue?: () => Promise<void> };
    return typeof q.stopQueue === 'function' ? q.stopQueue() : undefined;
  }));
  await settleWrites(left());
  const mirror = (globalThis as unknown as { __stateMirror?: Map<string, Promise<void>> }).__stateMirror;
  if (mirror?.size) await within(Promise.allSettled([...mirror.values()]));
}

/**
 * SIGTERM / SIGINT (GitHub Actions cancelling or timing out the run, or Ctrl+C): takes no more calls,
 * puts the calls not started yet back in the queue (the next worker takes them), answers the
 * running ones with an error (their job is cut off), marks itself offline and waits for the
 * pending writes. Then exits.
 */
async function shutdown(sig: string) {
  if (g.__workerStopping) return;
  g.__workerStopping = true;
  stopTakingJobs(`stopped (${sig})`);
  // GitHub Actions follows a cancel's SIGINT with SIGTERM after 7.5 s and SIGKILL 2.5 s later: be done by then.
  const hardStop = setTimeout(() => process.exit(143), 9_000);
  hardStop.unref?.();
  try {
    const id = held.id;
    if (id && !missingEnv().length) {
      const back = held.waiting.splice(0).map((w) => w.id);
      if (back.length) await db().from('worker_calls').update({ status: 'queued', worker_id: null, claimed_at: null }).in('id', back).eq('status', 'running').then(() => {}, () => {});
      const cut = [...held.running];
      if (cut.length) {
        await db().from('worker_calls').update({ status: 'failed', error: 'The worker stopped (it is being restarted) before it could answer — try again in a minute', done_at: new Date().toISOString() })
          .in('id', cut).eq('status', 'running').then(() => {}, () => {});
      }
      await retire(id, `stopped (${sig})${back.length || cut.length ? `; ${back.length} call(s) handed back, ${cut.length} cut off` : ''}`).catch(() => {});
    }
    await finishWrites(6_000);
  } finally {
    process.exit(sig === 'SIGINT' ? 130 : 143);
  }
}

/** Calls nobody collected (the web side gave up), and workers not seen for a week. */
async function purge() {
  await db().from('worker_calls').delete().lt('expires_at', new Date(Date.now() - 5 * 60_000).toISOString());
  await db().from('workers').delete().lt('last_seen', new Date(Date.now() - 7 * 86_400_000).toISOString());
}
