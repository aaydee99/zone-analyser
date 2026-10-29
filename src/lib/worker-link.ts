import 'server-only';
import crypto from 'node:crypto';
import { db } from './supabase';
import { isLoopbackHost } from './hosts';
import { openRelay, sealRelay, signRelay } from './vault';
import type { Me } from './auth';

// ── Roles ────────────────────────────────────────────────────────────────────
// all    — one server does everything (the default when not on Vercel).
// web    — the UI and sign-in only (the default on Vercel). Every API call that runs a job,
//          reads Cloudflare / R2 / S3 or keeps state is handed to a worker through Supabase.
// worker — `npm run worker` on a machine or container with a fixed IP: does all of it, and
//          takes the calls the web side queues (src/lib/worker-loop.ts).

export type ConsoleRole = 'all' | 'web' | 'worker';

export function consoleRole(): ConsoleRole {
  const r = process.env.CONSOLE_ROLE?.trim().toLowerCase();
  if (r === 'web' || r === 'worker' || r === 'all') return r;
  return process.env.VERCEL ? 'web' : 'all';
}
export const isWebRole = () => consoleRole() === 'web';

/** The header a worker's own server trusts instead of a session cookie. */
export const RELAY_HEADER = 'x-console-relay';
/** A worker that has not been seen for this long is offline. */
const ONLINE_MS = 30_000;
/** Answers up to this size come back in one piece; larger ones (downloads) in chunks. */
export const RELAY_CHUNK = Number(process.env.CONSOLE_RELAY_CHUNK) || 512 * 1024;
const MAX_REQUEST_BODY = 2 * 1024 * 1024;

// ── Worker status ────────────────────────────────────────────────────────────

export interface WorkerInfo {
  id: string;
  hostname: string;
  publicIp: string | null;
  version: string | null;
  platform: string | null;
  tools: { name: string; version: string | null }[] | null;
  startedAt: string;
  lastSeen: string;
  online: boolean;
}

interface WorkerRow { id: string; hostname: string; public_ip: string | null; version: string | null; platform: string | null; tools: WorkerInfo['tools']; started_at: string; last_seen: string }

const g = globalThis as unknown as { __workerSeen?: { at: number; value: WorkerInfo | null } };

/** The most recently seen worker (cached for 3 s), or null when none ever started. */
export async function latestWorker(fresh = false): Promise<WorkerInfo | null> {
  const hit = g.__workerSeen;
  if (!fresh && hit && Date.now() - hit.at < 3000) return hit.value;
  const { data, error } = await db().from('workers').select('id, hostname, public_ip, version, platform, tools, started_at, last_seen').order('last_seen', { ascending: false }).limit(1);
  if (error) {
    if (/workers|42P01|PGRST205/.test(`${error.code} ${error.message}`)) {
      throw new RelayError(503, 'The worker tables are missing: run supabase/migrations/0004_worker.sql in the Supabase SQL editor');
    }
    throw new RelayError(503, `Could not check the worker: ${error.message}`);
  }
  const r = (data as WorkerRow[])[0];
  const value: WorkerInfo | null = r ? {
    id: r.id, hostname: r.hostname, publicIp: r.public_ip, version: r.version, platform: r.platform, tools: r.tools,
    startedAt: r.started_at, lastSeen: r.last_seen, online: Date.now() - Date.parse(r.last_seen) < ONLINE_MS,
  } : null;
  g.__workerSeen = { at: Date.now(), value };
  return value;
}

export class RelayError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const OFFLINE = 'The worker is offline, so backups, restores, the vault and Cloudflare reads cannot run. Start it (README, Worker)';
const STARTING = 'The worker is starting (GitHub Actions, about 2–3 minutes). Try again in a moment';
/** How long a request waits for a worker that is being started before it answers "starting". */
const wakeWait = () => Math.max(0, Number(process.env.CONSOLE_WAKE_WAIT_MS) || 45_000);

/** An online worker, starting one on GitHub Actions when that is set up (and waiting a little for it). */
async function onlineWorker(me: Me): Promise<WorkerInfo> {
  const w = await latestWorker();
  if (w?.online) return w;
  const { wakeWorker } = await import('./worker-wake');
  const wake = await wakeWorker(me.email);
  if (wake.result === 'unavailable') throw new RelayError(503, wake.message && !/not set up/.test(wake.message) ? `${OFFLINE}. Starting it on GitHub failed: ${wake.message}` : OFFLINE);
  const until = Date.now() + wakeWait();
  while (Date.now() < until) {
    await sleep(2_000);
    const now = await latestWorker(true);
    if (now?.online) return now;
  }
  throw new RelayError(503, STARTING);
}

// ── Relaying a request (web side) ────────────────────────────────────────────

/** What the web side queues: the request as the browser sent it, and who sent it. */
export interface RelayRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  me: Me;
  /** The signed identity the worker's server checks (see relayedMe). */
  identity: string;
}

/** What the worker writes back. `body` is base64; omitted when the answer is in chunks. */
export interface RelayResponse {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

const FORWARD_REQUEST_HEADERS = ['content-type', 'accept'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const aadFor = (id: string, part = 'request') => `worker-call:${id}:${part}`;

/** How long the web side waits for an answer (Vercel ends the function at its maxDuration). */
const relayTimeout = () => Math.max(5_000, Number(process.env.CONSOLE_RELAY_TIMEOUT_MS) || 280_000);

/**
 * Hands one API request to the worker and answers with what it answered. The worker runs the
 * same route on its own server, as `me`, after this side has checked the session, the role and
 * the rate limits.
 */
export async function relay(req: Request, me: Me, timeoutMs = relayTimeout()): Promise<Response> {
  const url = new URL(req.url);
  let body: string | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.length > MAX_REQUEST_BODY) throw new RelayError(413, 'Request is too large');
    if (buf.length) body = buf.toString('base64');
  }
  const headers: Record<string, string> = {};
  for (const h of FORWARD_REQUEST_HEADERS) { const v = req.headers.get(h); if (v) headers[h] = v; }
  return send({ method: req.method, path: url.pathname + url.search, headers, body, me }, timeoutMs, req.signal);
}

/** A JSON GET through the worker (used to add the worker's live state to /api/auth/me). */
export async function relayJson<T>(me: Me, path: string, timeoutMs: number): Promise<T | null> {
  try {
    const res = await send({ method: 'GET', path, headers: { accept: 'application/json' }, me }, timeoutMs, undefined, false);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

async function send(r: Omit<RelayRequest, 'identity'>, timeoutMs: number, signal?: AbortSignal, wake = true): Promise<Response> {
  if (wake) await onlineWorker(r.me);
  else if (!(await latestWorker())?.online) throw new RelayError(503, OFFLINE);
  const id = crypto.randomUUID();
  const claims = JSON.stringify({ me: r.me, method: r.method, path: r.path, call: id, exp: Date.now() + timeoutMs + 60_000 });
  const identity = `${Buffer.from(claims).toString('base64url')}.${await signRelay(claims)}`;
  const request: RelayRequest = { ...r, identity };
  const sealed = await sealRelay(Buffer.from(JSON.stringify(request)), aadFor(id));
  const ins = await db().from('worker_calls').insert({ id, request: sealed, expires_at: new Date(Date.now() + timeoutMs).toISOString() });
  if (ins.error) throw new RelayError(503, `Could not queue the call for the worker: ${ins.error.message}`);

  const started = Date.now();
  try {
    for (let i = 0; ; i++) {
      if (signal?.aborted) throw new RelayError(499, 'The request was cancelled');
      if (Date.now() - started > timeoutMs) throw new RelayError(504, 'The worker did not answer in time (it may still finish the job: check again shortly)');
      await sleep(i < 20 ? 100 : 300);
      const { data, error } = await db().from('worker_calls').select('status, response, chunks, error').eq('id', id).maybeSingle();
      if (error) throw new RelayError(503, `Could not read the worker's answer: ${error.message}`);
      const row = data as { status: string; response: unknown; chunks: number; error: string | null } | null;
      if (!row) throw new RelayError(504, 'The call expired before the worker answered');
      if (row.status === 'failed') throw new RelayError(502, `The worker could not run this: ${row.error ?? 'unknown error'}`);
      if (row.status !== 'done') {
        // Queued for long: the worker may have stopped since it was last seen.
        if (row.status === 'queued' && Date.now() - started > 10_000 && !(await latestWorker(true))?.online) throw new RelayError(503, OFFLINE);
        continue;
      }
      const answer = JSON.parse((await openRelay(row.response as never, aadFor(id, 'response'))).toString('utf8')) as RelayResponse;
      const headers = new Headers(answer.headers);
      if (!row.chunks) {
        void cleanup(id);
        return new Response(answer.body ? new Uint8Array(Buffer.from(answer.body, 'base64')) : null, { status: answer.status, headers });
      }
      return new Response(chunkStream(id, row.chunks), { status: answer.status, headers });
    }
  } catch (err) {
    void cleanup(id);
    throw err;
  }
}

/** A large answer, read chunk by chunk from worker_call_chunks. */
function chunkStream(id: string, chunks: number): ReadableStream<Uint8Array> {
  let seq = 0;
  return new ReadableStream({
    async pull(controller) {
      if (seq >= chunks) { controller.close(); void cleanup(id); return; }
      const { data, error } = await db().from('worker_call_chunks').select('data').eq('call_id', id).eq('seq', seq).maybeSingle();
      if (error || !data) { controller.error(new Error('A part of the answer is missing')); void cleanup(id); return; }
      controller.enqueue(new Uint8Array(await openRelay((data as { data: never }).data, aadFor(id, `chunk:${seq}`))));
      seq++;
    },
    cancel() { void cleanup(id); },
  });
}

/** The call is read (or abandoned): its row and chunks are deleted. */
async function cleanup(id: string) {
  await db().from('worker_calls').delete().eq('id', id);
}

// ── Accepting a relayed request (worker side) ────────────────────────────────

/**
 * The identity of a request the worker loop replays on this server: only on a worker, only over
 * loopback, only with a valid signature for this method and path, and only before it expires.
 * null when the request carries no relay header.
 */
export async function relayedMe(req: Request): Promise<Me | null> {
  const header = req.headers.get(RELAY_HEADER);
  if (!header) return null;
  const refuse = () => new RelayError(401, 'Relayed request refused');
  if (consoleRole() !== 'worker' || !isLoopbackHost(req.headers.get('host'))) throw refuse();
  const [b64, sig] = header.split('.');
  if (!b64 || !sig) throw refuse();
  const claims = Buffer.from(b64, 'base64url').toString('utf8');
  const want = Buffer.from(await signRelay(claims));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw refuse();
  const c = JSON.parse(claims) as { me: Me; method: string; path: string; exp: number };
  const url = new URL(req.url);
  if (c.exp < Date.now() || c.method !== req.method || c.path !== url.pathname + url.search) throw refuse();
  return c.me;
}

// ── Which API calls stay on the web side ─────────────────────────────────────

/** Sign-in, accounts and the audit log only need Supabase; everything else goes to the worker. */
const WEB_ROUTES = [
  /^\/api\/auth\/(login|logout|password|me)$/,
  /^\/api\/setup(\/|$)/,
  /^\/api\/users(\/|$)/,
  /^\/api\/audit(\/|$)/,
  // Live logs are followed in Supabase (run_logs), not through the queue.
  /^\/api\/runs\/[^/]+\/stream$/,
];

export const relayed = (req: Request) => isWebRole() && !WEB_ROUTES.some((r) => r.test(new URL(req.url).pathname));
