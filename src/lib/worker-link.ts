import 'server-only';
import crypto from 'node:crypto';
import { db } from './supabase';
import { hasLocalToken, isLoopbackHost } from './hosts';
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
const ONLINE_MS = 180_000;
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
  /** Asked to stop for this (newer) version of the console. */
  retireRequested: string | null;
}

interface WorkerRow { id: string; hostname: string; public_ip: string | null; version: string | null; platform: string | null; tools: WorkerInfo['tools']; started_at: string; last_seen: string; retire_requested?: string | null }

const g = globalThis as unknown as { __workerSeen?: { at: number; value: WorkerInfo | null } };

/** The most recently seen worker (cached for 3 s), or null when none ever started. */
export async function latestWorker(fresh = false): Promise<WorkerInfo | null> {
  const hit = g.__workerSeen;
  if (!fresh && hit && Date.now() - hit.at < 3000) return hit.value;
  const { data, error } = await db().from('workers').select('*').order('last_seen', { ascending: false }).limit(1);
  if (error) {
    if (/workers|42P01|PGRST205/.test(`${error.code} ${error.message}`)) {
      throw new RelayError(503, 'The worker tables are missing: run supabase/migrations/0004_worker.sql in the Supabase SQL editor');
    }
    throw new RelayError(503, `Could not check the worker: ${error.message}`);
  }
  const r = (data as WorkerRow[])[0];
  const value: WorkerInfo | null = r ? {
    id: r.id, hostname: r.hostname, publicIp: r.public_ip, version: r.version, platform: r.platform, tools: r.tools,
    startedAt: r.started_at, lastSeen: r.last_seen, retireRequested: r.retire_requested ?? null, online: Date.now() - Date.parse(r.last_seen) < ONLINE_MS,
  } : null;
  g.__workerSeen = { at: Date.now(), value };
  return value;
}

// ── Replacing a worker that runs older code ─────────────────────────────────

const gv = globalThis as unknown as { __webVersion?: { version: string; firstSeen: string } };

/** This deployment's version (git commit on Vercel) and when it first ran, recorded in Supabase. */
async function webVersion(): Promise<{ version: string; firstSeen: string } | null> {
  const version = process.env.VERCEL_GIT_COMMIT_SHA?.trim() || process.env.CONSOLE_VERSION?.trim();
  if (!version) return null;
  if (gv.__webVersion?.version === version) return gv.__webVersion;
  await db().from('web_versions').upsert({ version }, { onConflict: 'version', ignoreDuplicates: true });
  const { data } = await db().from('web_versions').select('version, first_seen').eq('version', version).maybeSingle();
  const row = data as { version: string; first_seen: string } | null;
  if (!row) return null;
  gv.__webVersion = { version, firstSeen: row.first_seen };
  return gv.__webVersion;
}

/**
 * A worker that runs a different version and started before this one was deployed is asked to stop
 * (it finishes what it is doing first); the next request starts one with the new code. A worker
 * started after this deployment is kept, even if its version differs (Vercel may deploy later).
 */
export async function retireIfOutdated(w: WorkerInfo): Promise<boolean> {
  if (!w.online || !w.version || w.retireRequested) return !!w.retireRequested;
  const wv = await webVersion().catch(() => null);
  if (!wv || w.version === wv.version || Date.parse(w.startedAt) >= Date.parse(wv.firstSeen)) return false;
  const { error } = await db().from('workers').update({ retire_requested: wv.version }).eq('id', w.id);
  return !error;
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
/**
 * Calls that only look (the console's status poll every 20 s, health checks, the lists pages poll):
 * they are answered, but do not count as work, so an open console tab does not keep the worker
 * from stopping when idle.
 */
const PASSIVE_GETS = [/^\/api\/auth\/me$/, /^\/api\/health$/, /^\/api\/runs$/, /^\/api\/approvals$/, /^\/api\/restore\/history$/];
export const passiveCall = (r: Pick<RelayRequest, 'method' | 'path'>) => {
  if (r.method !== 'GET' && r.method !== 'HEAD') return false;
  const url = new URL(r.path, 'http://worker');
  return url.searchParams.get('peek') === '1' || PASSIVE_GETS.some((re) => re.test(url.pathname));
};

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
  const r = { method: req.method, path: url.pathname + url.search, headers, body, me };
  // A poll does not start a stopped worker (or an open tab would keep restarting it); real use does.
  return send(r, timeoutMs, req.signal, !passiveCall(r));
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
  const id = crypto.randomUUID();
  const claims = JSON.stringify(relayClaims(r.me, r.method, r.path, id, Date.now() + timeoutMs + 60_000, r.body ? Buffer.from(r.body, 'base64') : Buffer.alloc(0)));
  const [, sig] = await Promise.all([
    wake ? onlineWorker(r.me) : latestWorker().then((w) => { if (!w?.online) throw new RelayError(503, OFFLINE); }),
    signClaims(claims),
  ]);
  const identity = `${Buffer.from(claims).toString('base64url')}.${sig}`;
  const request: RelayRequest = { ...r, identity };
  const sealed = await sealRelay(Buffer.from(JSON.stringify(request)), aadFor(id));
  const ins = await db().from('worker_calls').insert({ id, request: sealed, expires_at: new Date(Date.now() + timeoutMs).toISOString() });
  if (ins.error) throw new RelayError(503, `Could not queue the call for the worker: ${ins.error.message}`);

  const started = Date.now();
  try {
    for (let i = 0; ; i++) {
      if (signal?.aborted) throw new RelayError(499, 'The request was cancelled');
      if (Date.now() - started > timeoutMs) throw new RelayError(504, 'The worker did not answer in time (it may still finish the job: check again shortly)');
      await sleep(Math.min(25 * 2 ** Math.floor(i / 2), 250));
      const { data, error } = await db().from('worker_calls').select('status, response, chunks, error').eq('id', id).maybeSingle();
      if (error) throw new RelayError(503, `Could not read the worker's answer: ${error.message}`);
      const row = data as { status: string; response: unknown; chunks: number; error: string | null } | null;
      if (!row) throw new RelayError(504, 'The call expired before the worker answered');
      if (row.status === 'failed') throw new RelayError(502, `The worker could not run this: ${row.error ?? 'unknown error'}`);
      if (row.status !== 'done') {
        // Queued for long: the worker may have stopped since it was last seen.
        if (row.status === 'queued' && Date.now() - started > 10_000 && !(await latestWorker(true))?.online) {
          // The worker stopped after the call was queued: start it (and wait for it) when allowed.
          if (!wake) throw new RelayError(503, OFFLINE);
          await onlineWorker(r.me);
        }
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

// ── Signing (both sides) ─────────────────────────────────────────────────────

/** What the web side signs for each call: who, what (method, path and a SHA-256 of the body), which call, until when. */
export interface RelayClaims { v: 2; me: Me; method: string; path: string; call: string; exp: number; body: string }

const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');

export function relayClaims(me: Me, method: string, path: string, call: string, exp: number, body: Uint8Array): RelayClaims {
  return { v: 2, me, method, path, call, exp, body: sha256(body) };
}

/**
 * HMAC-SHA256 (base64url) of the claims. With RELAY_SIGNING_KEY set (the same value on the web side
 * and the worker, at least 32 characters) that key signs; otherwise one derived from the vault server key.
 */
export async function signClaims(claims: string): Promise<string> {
  const own = process.env.RELAY_SIGNING_KEY?.trim();
  if (!own) return signRelay(claims);
  if (own.length < 32) throw new RelayError(503, 'RELAY_SIGNING_KEY must be at least 32 characters (the same value on Vercel and the worker)');
  const k = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(own, 'utf8'), Buffer.alloc(0), 'backup-console relay sign env v1', 32));
  try { return crypto.createHmac('sha256', k).update(claims).digest('base64url'); } finally { k.fill(0); }
}

// ── Accepting a relayed request (worker side) ────────────────────────────────

const gu = globalThis as unknown as { __relayUsed?: Map<string, number> };
const usedHere = (gu.__relayUsed ??= new Map<string, number>());
let nonceTableMissing = 0;

/**
 * A call id is accepted once: remembered in this process, and in public.relay_calls_used
 * (0014_rate_limits.sql) so no other worker accepts it either. Without that table, in memory only.
 */
async function useCallOnce(call: string, exp: number): Promise<boolean> {
  const now = Date.now();
  if (usedHere.has(call)) return false;
  usedHere.set(call, exp);
  if (usedHere.size > 5_000) for (const [k, until] of usedHere) if (until < now) usedHere.delete(k);
  if (now < nonceTableMissing) return true;
  const { data, error } = await db().rpc('relay_call_use', { p_call: call, p_expires_at: new Date(exp).toISOString() });
  if (error) {
    if (/PGRST202|PGRST205|42883|42P01|relay_call/.test(`${error.code} ${error.message}`)) {
      if (!nonceTableMissing) console.warn('[worker] relayed calls are remembered in memory only: apply supabase/migrations/0014_rate_limits.sql');
      nonceTableMissing = now + 5 * 60_000;
      return true;
    }
    throw new RelayError(503, 'Could not check the relayed call');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { used?: boolean } | undefined;
  return row?.used === true;
}

/**
 * The identity of a request the worker loop replays on this server: only on a worker, only from the
 * worker loop of this same process (loopback Host AND its per-process token, src/lib/hosts.ts), only
 * with a valid signature over this method, path and body, only before it expires, and only once per
 * call id. null when the request carries no relay header.
 */
export async function relayedMe(req: Request): Promise<Me | null> {
  const header = req.headers.get(RELAY_HEADER);
  if (!header) return null;
  const refuse = () => new RelayError(401, 'Relayed request refused');
  if (consoleRole() !== 'worker' || !isLoopbackHost(req.headers.get('host')) || !hasLocalToken(req.headers)) throw refuse();
  const [b64, sig] = header.split('.');
  if (!b64 || !sig) throw refuse();
  const claims = Buffer.from(b64, 'base64url').toString('utf8');
  const want = Buffer.from(await signClaims(claims));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw refuse();
  let c: Partial<RelayClaims>;
  try { c = JSON.parse(claims) as Partial<RelayClaims>; } catch { throw refuse(); }
  const url = new URL(req.url);
  if (c.v !== 2 || !c.me || typeof c.call !== 'string' || typeof c.body !== 'string' || typeof c.exp !== 'number') throw refuse();
  if (c.exp < Date.now() || c.method !== req.method || c.path !== url.pathname + url.search) throw refuse();
  // The body as received (a copy: the route reads the request itself).
  const body = req.method === 'GET' || req.method === 'HEAD' ? new Uint8Array(0) : new Uint8Array(await req.clone().arrayBuffer());
  const gotBody = Buffer.from(sha256(body));
  const wantBody = Buffer.from(c.body);
  if (gotBody.length !== wantBody.length || !crypto.timingSafeEqual(gotBody, wantBody)) throw refuse();
  if (!(await useCallOnce(c.call, c.exp))) throw refuse();
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
