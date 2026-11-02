'use client';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

// ── Answers shared by every page of this browser tab ─────────────────────────
// Lists that change only when someone edits them (the zone list, stored credentials, tags,
// accounts, saved views) are asked for once: a page that needs what another page already read
// uses that answer, also while it is still being read, for up to KEPT_MS. Refresh (`fresh`, or
// &fresh=1) reads again; a change made through the API (POST, PUT, PATCH, DELETE) forgets what it
// can make stale (WRITES), everything for a change not listed there.
// Data that changes by the second (traffic, Cloudflare activity) is shared only while it is being
// read: every page that opens later asks again. Live state (runs, approvals, the worker, the vault,
// health, investigations) is never kept.
const EXPLORER = /^\/api\/zone-explorer(\/|\?|$)/;
const TAGS = /^\/api\/zones\/tags(\?|$)/;
const VIEWS = /^\/api\/me\/views(\?|$)/;
const SHARED = [
  EXPLORER, TAGS, VIEWS, /^\/api\/cloudflare-audit\/history(\?|$)/, /^\/api\/credentials\/options(\?|$)/, /^\/api\/zones(\?|$)/,
  /^\/api\/investigate\/zones\?(.*&)?accounts=1(&|$)/, /^\/api\/tools\/api-console(\?|$)/, /^\/api\/tools\/api-console\/accounts(\?|$)/,
];
/** Read again by every page that asks (shared only while a read is under way). */
const LIVE = [/^\/api\/traffic(\/|\?|$)/, /^\/api\/cloudflare-audit(\?|$)/];
/** A kept answer older than this is read again. */
const KEPT_MS = 10 * 60_000;
/** Changes that make only some kept answers stale (or none): the zone explorer list carries tags and owners. */
const WRITES: [string, RegExp[]][] = [
  ['/api/me/views', [VIEWS]], ['/api/me', []], ['/api/runs', []], ['/api/reports', []], ['/api/presets', []], ['/api/compare/templates', []],
  ['/api/monitors', []], ['/api/search/index', []], ['/api/tools/api-console/saved', []], ['/api/tools/api-console/query', []], ['/api/tools/worker-logs', []],
  ['/api/zones/meta', [EXPLORER, TAGS]], ['/api/zones/tags', [EXPLORER, TAGS]],
];
const under = (path: string, prefix: string) => path.startsWith(prefix) && /^([/?]|$)/.test(path.slice(prefix.length));
/** Called after a change is sent (POST, PUT, PATCH, DELETE), with its path: the stores forget what it can make stale. */
const writeListeners = new Set<(path: string) => void>();
export function onWrite(fn: (path: string) => void) { writeListeners.add(fn); return () => { writeListeners.delete(fn); }; }
/** Which kept answers a change makes stale: none, the zone explorer's, or all of them. */
export function staleAfter(path: string): 'none' | 'explorer' | 'all' {
  const w = WRITES.find(([p]) => under(path, p));
  return !w ? 'all' : w[1].includes(EXPLORER) ? 'explorer' : 'none';
}
function forgetFor(path: string) {
  for (const fn of writeListeners) { try { fn(path); } catch { /* a store's own problem */ } }
  const w = WRITES.find(([p]) => under(path, p));
  if (!w) { forgetShared(); return; }
  for (const key of [...kept.keys()]) if (w[1].some((r) => r.test(key))) { kept.delete(key); keptAt.delete(key); }
}
const MAX_KEPT = 80;
const kept = new Map<string, Promise<{ status: number; body: unknown }>>();
/** When each kept answer was asked for. */
const keptAt = new Map<string, number>();
/** The path without what does not change the answer: `fresh` (read again) and `job` (which read a poll follows). */
function keyOf(path: string) {
  const [p, q = ''] = path.split('?');
  const params = new URLSearchParams(q);
  params.delete('fresh');
  params.delete('job');
  params.sort();
  const rest = params.toString();
  return rest ? `${p}?${rest}` : p;
}
/** Forget every kept answer (after a change, or when the user asks for everything again). */
export function forgetShared() { kept.clear(); keptAt.clear(); }

/** A request cancelled through its `signal`: not an error to show. */
export const isAbort = (e: unknown) => (e as Error | null)?.name === 'AbortError';

/**
 * JSON fetch for the console API. A 401 means the session ended — bounce to sign-in.
 * (A locked vault answers 423, which stays on the page.) Heavy reads are shared between pages
 * (see above); `fresh` reads again. `signal` cancels: the call rejects with an AbortError (isAbort).
 */
export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown; fresh?: boolean } = {}): Promise<T> {
  const { fresh, ...opts } = init;
  const method = (opts.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') { forgetFor(path); return request<T>(path, opts); }
  const live = LIVE.some((r) => r.test(path));
  if (!live && !SHARED.some((r) => r.test(path))) return request<T>(path, opts);
  const key = keyOf(path);
  const again = fresh || /[?&]fresh=1(&|$)/.test(path);
  if (Date.now() - (keptAt.get(key) ?? 0) > KEPT_MS) { kept.delete(key); keptAt.delete(key); }
  const hit = kept.get(key);
  if (hit && !again) {
    // A shared read that ends as "still reading" or an error: this caller asks itself.
    const r = await hit.catch(() => null);
    opts.signal?.throwIfAborted();
    if (r) return r.body as T;
  }
  const p = send(path, opts);
  // Kept only once it is a complete answer (200): "still reading" (202) and errors are asked again.
  // Live data is not kept once it has arrived.
  const mine = p.then((r) => { if (r.status !== 200) throw new Error('not kept'); return r; });
  const forget = () => { if (kept.get(key) === mine) { kept.delete(key); keptAt.delete(key); } };
  if (live) mine.then(forget, forget); else mine.catch(forget);
  kept.set(key, mine);
  keptAt.set(key, Date.now());
  if (kept.size > MAX_KEPT) { const k = kept.keys().next().value!; kept.delete(k); keptAt.delete(k); }
  return (await p).body as T;
}

async function request<T>(path: string, init: RequestInit & { json?: unknown }): Promise<T> {
  return (await send(path, init)).body as T;
}

async function send(path: string, init: RequestInit & { json?: unknown }): Promise<{ status: number; body: unknown }> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: 'no-store',
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty */ }
  // Cancelled while the body was read: not a (kept) empty answer.
  rest.signal?.throwIfAborted();
  if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/setup') && !path.startsWith('/api/vault/')) {
    window.location.href = `/console/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`, body);
  return { status: res.status, body };
}

export function relTime(iso?: string | number | null): string {
  if (!iso) return '—';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 604800) return `${Math.round(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function duration(startIso: string, endIso?: string): string {
  const ms = (endIso ? Date.parse(endIso) : Date.now()) - Date.parse(startIso);
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

export const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—');

export async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}
