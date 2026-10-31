import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { tag } from './cache';

// Cloudflare API calls for the monitoring checks and actions. Every call spends from one budget per
// token (a "lane"): Cloudflare allows 1,200 calls per 5 minutes per user or token. Monitoring takes
// at most MONITOR_BUDGET of it (800 by default) and none at all while a backup or restore uses the
// token, which then has it to itself; actions and analytics may use up to 1,150. Calls wait for room
// instead of going over, and a 429 pauses the token until Cloudflare's Retry-After has passed.
// Tokens never leave this module except in the Authorization header.

const CF_API = 'https://api.cloudflare.com/client/v4';
const WINDOW_MS = 5 * 60_000;
export const MONITOR_BUDGET = Math.max(20, Number(process.env.MONITOR_BUDGET) || 800);
const TOTAL_BUDGET = Math.max(MONITOR_BUDGET, 1_150);
/** Longest a call waits for room in the budget before the check gives up on it. */
const MAX_WAIT_MS = 90_000;

/** A monitoring unit's calls: counted, and held back while its lane is paused. */
export interface MonitorCalls { calls: number }
const monitorScope = new AsyncLocalStorage<MonitorCalls>();
/** Runs `fn` as monitoring work: its calls use the monitoring budget and are counted in `m`. */
export const asMonitor = <T>(m: MonitorCalls, fn: () => Promise<T>) => monitorScope.run(m, fn);

const gp = globalThis as unknown as { __cfLanePaused?: { fn: (lane: string) => string | null } };
const pause = (gp.__cfLanePaused ??= { fn: () => null });
/** Says why monitoring must not use a lane right now (a backup or restore uses that token), or null. */
export function setLanePause(fn: (lane: string) => string | null) { pause.fn = fn; }
/** The lane (budget) a token spends from. */
export const laneOf = (token: string) => tag(token);

interface Bucket { calls: number[]; pausedUntil: number }
const gb = globalThis as unknown as { __cfBudget?: Map<string, Bucket> };
const buckets = (gb.__cfBudget ??= new Map<string, Bucket>());

export class BudgetError extends Error {
  constructor(why?: string) { super(why ? `${why} — checked again later` : 'Waited too long for Cloudflare’s rate limit — the rest is read on the next run'); }
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('Stopped')); }, { once: true });
});

/** Takes one call from the token's budget, waiting while it is spent or paused by a 429 (or, for monitoring, by a backup). */
async function take(token: string, signal?: AbortSignal) {
  const key = tag(token);
  const b = buckets.get(key) ?? { calls: [], pausedUntil: 0 };
  buckets.set(key, b);
  const m = monitorScope.getStore();
  const limit = m ? MONITOR_BUDGET : TOTAL_BUDGET;
  const started = Date.now();
  for (;;) {
    const now = Date.now();
    b.calls = b.calls.filter((t) => t > now - WINDOW_MS);
    const held = m ? pause.fn(key) : null;
    const wait = held ? 5_000 : Math.max(b.pausedUntil - now, b.calls.length >= limit ? b.calls[b.calls.length - limit] + WINDOW_MS - now : 0);
    if (wait <= 0) { b.calls.push(now); if (m) m.calls++; return; }
    if (now - started + wait > MAX_WAIT_MS) throw new BudgetError(held ?? undefined);
    await sleep(Math.min(wait, 5_000), signal);
  }
}

/** A lane's use of the current 5-minute window. */
export function laneUse(lane: string): { used: number; pausedUntil: number } {
  const b = buckets.get(lane);
  if (!b) return { used: 0, pausedUntil: 0 };
  const now = Date.now();
  return { used: b.calls.filter((t) => t > now - WINDOW_MS).length, pausedUntil: b.pausedUntil > now ? b.pausedUntil : 0 };
}

export interface CfError { code?: number; message?: string }
export interface CfEnvelope<T = unknown> { success?: boolean; errors?: CfError[]; result?: T; result_info?: { page?: number; total_pages?: number; cursor?: string; count?: number; total_count?: number; per_page?: number } }
export interface CfAnswer<T = unknown> { status: number; body: CfEnvelope<T> | null; text?: string }

/** One call. Never throws for Cloudflare's answers (the caller gets the status and envelope); throws BudgetError or on abort. */
export async function cfCall<T = unknown>(token: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<CfAnswer<T>> {
  await take(token, signal);
  try {
    const res = await fetch(`${CF_API}${path}`, {
      method, cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      // AbortSignal.any is Node 20.3+; on older Node a stop takes effect after the call instead.
      signal: signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after')) || 60;
      const b = buckets.get(tag(token));
      if (b) b.pausedUntil = Date.now() + Math.min(after, 300) * 1000;
    }
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) as CfEnvelope<T> }; } catch { return { status: res.status, body: null, text }; }
  } catch (err) {
    if (signal?.aborted) throw err;
    return { status: 0, body: null };
  }
}

export const cfGet = <T = unknown>(token: string, path: string, signal?: AbortSignal) => cfCall<T>(token, 'GET', path, undefined, signal);

/** Cloudflare's reason, in one line. */
export function cfReason(r: { status: number; body: CfEnvelope | null }) {
  const msg = r.body?.errors?.map((e) => e.message).filter(Boolean).join('; ');
  if (msg) return msg;
  if (r.status === 0) return 'Could not reach the Cloudflare API';
  if (r.status === 429) return 'Cloudflare’s rate limit was reached';
  return `HTTP ${r.status}`;
}

/** The token lacks a permission, the plan lacks the product, or the resource is not there. */
export const refused = (r: { status: number }) => r.status === 401 || r.status === 403;
export const ok = (r: CfAnswer) => r.status >= 200 && r.status < 300 && r.body?.success !== false && !!r.body;

export class ReadError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** The result of one GET, or a ReadError with Cloudflare's reason. */
export async function cfOne<T>(token: string, path: string, signal?: AbortSignal): Promise<T> {
  const r = await cfGet<T>(token, path, signal);
  if (!ok(r)) throw new ReadError(r.status, refused(r) ? `The token cannot read this (${cfReason(r)})` : cfReason(r));
  return r.body!.result as T;
}

/** Every item of a list, following page numbers or a cursor, up to `max`. */
export async function cfList<T>(token: string, path: string, opts: { perPage?: number; max?: number; signal?: AbortSignal } = {}): Promise<T[]> {
  const { perPage = 50, max = 5_000, signal } = opts;
  const out: T[] = [];
  let page = 1;
  let cursor = '';
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const q = new URLSearchParams();
    if (perPage) q.set('per_page', String(perPage));
    if (cursor) q.set('cursor', cursor); else if (page > 1) q.set('page', String(page));
    const r = await cfGet<T[]>(token, `${path}${sep}${q}`, signal);
    if (!ok(r)) {
      if (out.length) break; // a later page failed: keep what was read
      throw new ReadError(r.status, refused(r) ? `The token cannot read this (${cfReason(r)})` : cfReason(r));
    }
    const rows = Array.isArray(r.body!.result) ? r.body!.result : [];
    out.push(...rows);
    const info = r.body!.result_info ?? {};
    if (out.length >= max || !rows.length) break;
    if (info.cursor) { cursor = info.cursor; continue; }
    if (info.total_pages && page < info.total_pages) { page++; continue; }
    break;
  }
  return out.slice(0, max);
}

// ── Masking ─────────────────────────────────────────────────────────────────

const SECRET = /secret|password|passwd|private_?key|custom_?key|api_?key|client_?key|psk|authorization|signing_?key|access_?key|^token$|_token$|^auth_?key$/i;
const URL_SECRET = /([?&](?:[^=&]*(?:secret|key|sig|token|password|auth|credential)[^=&]*)=)[^&\s"]*/gi;
export const MASK = '••••••••';

/** Masks secret-looking values (by key) and credentials inside URLs (e.g. Logpush destinations). Nothing is cut short. */
export function mask(v: unknown, depth = 0): unknown {
  if (depth > 40) return v;
  if (Array.isArray(v)) return v.map((x) => mask(x, depth + 1));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' && x && SECRET.test(k) ? MASK : mask(x, depth + 1)]));
  }
  return typeof v === 'string' && v.includes('=') ? v.replace(URL_SECRET, `$1${MASK}`) : v;
}

/** Runs `fn` over `items`, `n` at a time, keeping the order. */
export async function inParallel<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
