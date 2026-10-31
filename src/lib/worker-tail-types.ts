// Live Worker logs: the filters Cloudflare's tail applies, and the short form of each event the
// console keeps while a session runs. Shared by server and client — no Node imports.

/** A session stops by itself after this long. */
export const TAIL_MINUTES = 10;
/** The page asks for new events this often while it is open and visible. */
export const TAIL_POLL_MS = 3_000;
/** Without a request from the page for this long (tab closed or hidden), the session stops. */
export const TAIL_VIEWER_IDLE_MS = 90_000;
/** Events kept per session (older ones are dropped as new ones arrive). */
export const TAIL_KEEP = 1_000;

export type TailStatus = 'ok' | 'error' | 'exception' | 'canceled';
export const TAIL_STATUSES: { value: TailStatus; label: string }[] = [
  { value: 'ok', label: 'OK' }, { value: 'error', label: 'Error' }, { value: 'exception', label: 'Exception' }, { value: 'canceled', label: 'Canceled' },
];
export const TAIL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export interface TailFilters {
  status: TailStatus[];
  methods: string[];
  /** Text that console.log messages must contain (Cloudflare's "query" filter). */
  search: string;
  /** 0.01–1: the share of events Cloudflare sends. */
  sampling: number;
}

export class FilterError extends Error {}

export function checkFilters(raw: unknown): TailFilters {
  const f = (raw ?? {}) as Record<string, unknown>;
  const status = (Array.isArray(f.status) ? f.status : []).map(String);
  for (const s of status) if (!TAIL_STATUSES.some((x) => x.value === s)) throw new FilterError(`Unknown status “${s}”`);
  const methods = (Array.isArray(f.methods) ? f.methods : []).map((m) => String(m).toUpperCase());
  for (const m of methods) if (!TAIL_METHODS.includes(m)) throw new FilterError(`Unknown method “${m}”`);
  const search = typeof f.search === 'string' ? f.search.trim() : '';
  if (search.length > 200) throw new FilterError('The search text is longer than 200 characters');
  const sampling = f.sampling === undefined || f.sampling === null || f.sampling === '' ? 1 : Number(f.sampling);
  if (!Number.isFinite(sampling) || sampling < 0.01 || sampling > 1) throw new FilterError('Sampling must be between 1% and 100%');
  return { status: [...new Set(status)] as TailStatus[], methods: [...new Set(methods)], search, sampling };
}

/** Cloudflare's outcomes for each status (as wrangler tail maps them). */
const OUTCOMES: Record<TailStatus, string[]> = {
  ok: ['ok'],
  error: ['exception', 'exceededCpu', 'exceededMemory', 'exceededWallTime', 'scriptNotFound', 'unknown'],
  exception: ['exception'],
  canceled: ['canceled', 'responseStreamDisconnected'],
};

/** The message sent on the tail's WebSocket once it opens. */
export function tailMessage(f: TailFilters): { filters: Record<string, unknown>[]; debug: boolean } {
  const filters: Record<string, unknown>[] = [];
  if (f.status.length) filters.push({ outcome: [...new Set(f.status.flatMap((s) => OUTCOMES[s]))] });
  if (f.methods.length) filters.push({ method: f.methods });
  if (f.search) filters.push({ query: f.search });
  if (f.sampling < 1) filters.push({ sampling_rate: f.sampling });
  return { filters, debug: false };
}

/** One event as the page shows it. Request headers, cookies and the client's IP are never kept. */
export interface TailItem {
  at: string;
  outcome: string;
  /** fetch, scheduled, queue, alarm, email, tail, rpc, other */
  kind: string;
  method?: string;
  url?: string;
  status?: number;
  colo?: string;
  /** Cron, queue name or alarm time: what started a non-fetch event. */
  trigger?: string;
  logs: { level: string; at: string | null; text: string }[];
  exceptions: { name: string; message: string }[];
  /** Logs or exceptions beyond the limits were left out. */
  cut?: boolean;
}
export interface TailEntry extends TailItem { seq: number }

const MAX_LOGS = 50;
const MAX_TEXT = 2_000;
const MAX_EXCEPTIONS = 10;

const SECRET_QUERY = /([?&](?:[^=&#]*(?:secret|key|sig|token|password|auth|credential|session|code)[^=&#]*)=)[^&#\s]*/gi;

/** The URL without user:password@ and with secret-looking query values blanked. */
export function scrubUrl(u: string): string {
  return u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@?#]*@/i, '$1').replace(SECRET_QUERY, '$1••••').slice(0, 2_048);
}

const iso = (ms: unknown) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const text = (v: unknown): string => {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
};

/** A raw tail event (trace-v1) in its short form, or null when it is not an event. */
export function reduceEvent(raw: unknown): TailItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const ev = (e.event ?? {}) as Record<string, unknown>;
  const req = (ev.request ?? null) as { url?: unknown; method?: unknown; cf?: { colo?: unknown } } | null;
  const res = (ev.response ?? null) as { status?: unknown } | null;
  const kind = req ? 'fetch' : 'cron' in ev ? 'scheduled' : 'queue' in ev ? 'queue' : 'scheduledTime' in ev ? 'alarm' : 'rcptTo' in ev ? 'email' : 'consumedEvents' in ev ? 'tail' : 'rpcMethod' in ev ? 'rpc' : 'other';
  const rawLogs = Array.isArray(e.logs) ? e.logs as { message?: unknown; level?: unknown; timestamp?: unknown }[] : [];
  const rawEx = Array.isArray(e.exceptions) ? e.exceptions as { name?: unknown; message?: unknown }[] : [];
  const item: TailItem = {
    at: iso(e.eventTimestamp) ?? new Date().toISOString(),
    outcome: typeof e.outcome === 'string' ? e.outcome.slice(0, 40) : 'unknown',
    kind,
    logs: rawLogs.slice(0, MAX_LOGS).map((l) => ({
      level: typeof l.level === 'string' ? l.level.slice(0, 10) : 'log',
      at: iso(l.timestamp),
      text: (Array.isArray(l.message) ? l.message.map(text).join(' ') : text(l.message ?? '')).slice(0, MAX_TEXT),
    })),
    exceptions: rawEx.slice(0, MAX_EXCEPTIONS).map((x) => ({ name: String(x.name ?? 'Error').slice(0, 100), message: String(x.message ?? '').slice(0, MAX_TEXT) })),
  };
  if (rawLogs.length > MAX_LOGS || rawEx.length > MAX_EXCEPTIONS) item.cut = true;
  if (req) {
    if (typeof req.method === 'string') item.method = req.method.slice(0, 10);
    if (typeof req.url === 'string') item.url = scrubUrl(req.url);
    if (typeof req.cf?.colo === 'string') item.colo = req.cf.colo.slice(0, 8);
  }
  if (res && typeof res.status === 'number') item.status = res.status;
  if (kind === 'scheduled') item.trigger = String(ev.cron ?? '').slice(0, 100);
  else if (kind === 'queue') item.trigger = String(ev.queue ?? '').slice(0, 100);
  else if (kind === 'rpc') item.trigger = String(ev.rpcMethod ?? '').slice(0, 100);
  return item;
}

export type TailState = 'starting' | 'running' | 'stopping' | 'stopped';
export interface TailSessionView {
  id: string;
  accountId: string;
  script: string;
  status: TailState;
  /** Why it stopped. */
  reason: string | null;
  filters: TailFilters;
  startedAt: string;
  expiresAt: string;
  events: number;
  /** Events left out because they came faster than the console keeps them. */
  dropped: number;
}
export interface TailPoll { session: TailSessionView; items: TailEntry[]; next: number }
