'use client';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

// ── Answers shared by every page of this browser tab ─────────────────────────
// Heavy reads (Cloudflare data) are asked for once: a page that needs what another page already
// read uses that answer, also while it is still being read. Refresh (`fresh`, or &fresh=1) reads
// again; a change made through the API (POST, PUT, PATCH, DELETE) forgets what it can make stale
// (WRITES), everything for a change not listed there. Live state (runs, approvals, the worker,
// the vault) is never kept.
const EXPLORER = /^\/api\/zone-explorer(\/|\?|$)/;
const SHARED = [EXPLORER, /^\/api\/traffic(\/|\?|$)/, /^\/api\/cloudflare-audit(\/history)?(\?|$)/, /^\/api\/credentials\/options(\?|$)/, /^\/api\/zones(\?|$)/];
/** Changes that make only some kept answers stale (or none): the zone explorer list carries tags and owners. */
const WRITES: [string, RegExp[]][] = [
  ['/api/me', []], ['/api/runs', []], ['/api/reports', []], ['/api/presets', []], ['/api/compare/templates', []],
  ['/api/monitors', []], ['/api/search/index', []], ['/api/tools/api-console/saved', []], ['/api/tools/worker-logs', []],
  ['/api/zones/meta', [EXPLORER]], ['/api/zones/tags', [EXPLORER]],
];
const under = (path: string, prefix: string) => path.startsWith(prefix) && /^([/?]|$)/.test(path.slice(prefix.length));
function forgetFor(path: string) {
  const w = WRITES.find(([p]) => under(path, p));
  if (!w) { kept.clear(); return; }
  for (const key of [...kept.keys()]) if (w[1].some((r) => r.test(key))) kept.delete(key);
}
const MAX_KEPT = 80;
const kept = new Map<string, Promise<{ status: number; body: unknown }>>();
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
export function forgetShared() { kept.clear(); }

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
  if (!SHARED.some((r) => r.test(path))) return request<T>(path, opts);
  const key = keyOf(path);
  const again = fresh || /[?&]fresh=1(&|$)/.test(path);
  const hit = kept.get(key);
  if (hit && !again) {
    // A shared read that ends as "still reading" or an error: this caller asks itself.
    const r = await hit.catch(() => null);
    opts.signal?.throwIfAborted();
    if (r) return r.body as T;
  }
  const p = send(path, opts);
  // Kept only once it is a complete answer (200): "still reading" (202) and errors are asked again.
  const mine = p.then((r) => { if (r.status !== 200) throw new Error('not kept'); return r; });
  mine.catch(() => { if (kept.get(key) === mine) kept.delete(key); });
  kept.set(key, mine);
  if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
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
