import 'server-only';
import crypto from 'node:crypto';
import { createClient } from 'redis';
import { db, isConfigured } from './supabase';

// Counters for rate limits and the sign-in throttle, shared by every console instance (on Vercel each
// function instance has its own memory, so counters kept there would let an attacker spread guesses):
//  - Redis, when REDIS_URL is set (the same server as the cache);
//  - else Supabase (public.rate_limits and rate_limit_hit(), supabase/migrations/0014_rate_limits.sql)
//    on Vercel or a web-role server — the deployments that run more than one instance;
//  - else this process's memory (one server: nothing to share).
// RATE_LIMIT_STORE=redis|supabase|memory picks one explicitly. A store that fails falls back to the
// next one for a while (a limiter must never take the console down); every fallback is logged.
// A window starts at the first hit of a key and lasts windowMs; keys are stored as SHA-256 hashes
// (no email address or IP in Redis or the table).

export interface Hit {
  /** count <= limit. */
  allowed: boolean;
  count: number;
  /** Milliseconds until the window ends. */
  resetMs: number;
}

type Store = 'redis' | 'supabase' | 'memory';
type Client = ReturnType<typeof createClient>;

/** Large enough to mean "never refuse, just count" (fits a Postgres integer). */
export const NO_LIMIT = 2_000_000_000;
const RETRY_MS = 30_000;
const MISSING_RETRY_MS = 5 * 60_000;
const PREFIX = `${process.env.REDIS_PREFIX?.trim() || 'backup-console'}:rl:`;

interface State {
  memory: Map<string, { count: number; resetAt: number }>;
  client: Client | null;
  connecting: Promise<Client | null> | null;
  redisDownUntil: number;
  dbDownUntil: number;
  warned: Map<string, number>;
}
const g = globalThis as unknown as { __rateStore?: State };
const s: State = (g.__rateStore ??= { memory: new Map(), client: null, connecting: null, redisDownUntil: 0, dbDownUntil: 0, warned: new Map() });

const keyHash = (key: string) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 40);

/** At most one line per reason every 10 minutes. */
function warn(reason: string, detail: string) {
  if ((s.warned.get(reason) ?? 0) > Date.now() - 600_000) return;
  s.warned.set(reason, Date.now());
  console.warn(`[rate-limit] ${detail}`);
}

/** The stores to try, best first. */
function stores(): Store[] {
  const forced = process.env.RATE_LIMIT_STORE?.trim().toLowerCase();
  if (forced === 'memory') return ['memory'];
  if (forced === 'redis') return ['redis', 'memory'];
  if (forced === 'supabase') return ['supabase', 'memory'];
  const list: Store[] = [];
  if (process.env.REDIS_URL?.trim()) list.push('redis');
  const many = !!process.env.VERCEL || process.env.CONSOLE_ROLE?.trim().toLowerCase() === 'web';
  if (many && isConfigured()) list.push('supabase');
  list.push('memory');
  return list;
}

/** Where counters live right now (for status pages and tests). */
export function rateStore(): Store {
  for (const st of stores()) {
    if (st === 'redis' && Date.now() >= s.redisDownUntil) return 'redis';
    if (st === 'supabase' && Date.now() >= s.dbDownUntil) return 'supabase';
    if (st === 'memory') return 'memory';
  }
  return 'memory';
}

// ── Redis ────────────────────────────────────────────────────────────────────

async function redis(): Promise<Client | null> {
  const url = process.env.REDIS_URL?.trim();
  if (!url || Date.now() < s.redisDownUntil) return null;
  if (s.client?.isReady) return s.client;
  s.connecting ??= (async () => {
    try {
      const c = createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: false } });
      c.on('error', (err) => redisDown(err));
      await c.connect();
      s.client = c;
      return c;
    } catch (err) {
      redisDown(err);
      return null;
    } finally {
      s.connecting = null;
    }
  })();
  return s.connecting;
}

/** Logs the reason, never the URL (it may hold a password). */
function redisDown(err: unknown) {
  warn('redis', `Redis unavailable for rate limits, using the next store for now: ${err instanceof Error ? err.message.replace(/\/\/[^@\s]*@/g, '//') : String(err)}`);
  s.redisDownUntil = Date.now() + RETRY_MS;
  const c = s.client;
  s.client = null;
  if (c?.isOpen) c.destroy();
}

const ttl = (pttl: unknown, windowMs: number) => (typeof pttl === 'number' && pttl > 0 ? pttl : windowMs);

async function redisHit(key: string, windowMs: number, limit: number): Promise<Hit | null> {
  const c = await redis();
  if (!c) return null;
  const k = PREFIX + keyHash(key);
  try {
    // One transaction: the window starts with the first hit (SET NX PX), INCR keeps its expiry.
    const [, count, pttl] = await c.multi()
      .set(k, '0', { condition: 'NX', expiration: { type: 'PX', value: windowMs } })
      .incr(k)
      .pTTL(k)
      .exec() as unknown as [unknown, number, number];
    if (typeof pttl === 'number' && pttl < 0) await c.pExpire(k, windowMs);
    return { allowed: Number(count) <= limit, count: Number(count), resetMs: ttl(pttl, windowMs) };
  } catch (err) {
    redisDown(err);
    return null;
  }
}

async function redisPeek(key: string): Promise<Hit | null | undefined> {
  const c = await redis();
  if (!c) return undefined;
  const k = PREFIX + keyHash(key);
  try {
    const [value, pttl] = await c.multi().get(k).pTTL(k).exec() as unknown as [string | null, number];
    if (value === null || !(Number(pttl) > 0)) return null;
    return { allowed: true, count: Number(value), resetMs: Number(pttl) };
  } catch (err) {
    redisDown(err);
    return undefined;
  }
}

// ── Supabase ─────────────────────────────────────────────────────────────────

function dbFailed(err: { code?: string; message?: string }) {
  const missing = /PGRST202|PGRST205|42883|42P01|rate_limit/.test(`${err.code} ${err.message}`);
  s.dbDownUntil = Date.now() + (missing ? MISSING_RETRY_MS : RETRY_MS);
  warn(missing ? 'db-missing' : 'db', missing
    ? 'Shared rate limits need supabase/migrations/0014_rate_limits.sql: until it is applied, each instance counts on its own'
    : `Supabase did not answer for rate limits, counting in memory for now: ${err.message ?? err.code}`);
}

interface HitRow { allowed: boolean; count: number; reset_ms: number }
const firstRow = (data: unknown) => (Array.isArray(data) ? data[0] : data) as HitRow | undefined;

async function dbHit(key: string, windowMs: number, limit: number): Promise<Hit | null> {
  if (Date.now() < s.dbDownUntil) return null;
  try {
    const { data, error } = await db().rpc('rate_limit_hit', { p_key: keyHash(key), p_window_ms: Math.round(windowMs), p_limit: Math.min(limit, NO_LIMIT) });
    if (error) { dbFailed(error); return null; }
    const r = firstRow(data);
    if (!r) return null;
    return { allowed: !!r.allowed, count: Number(r.count), resetMs: Math.max(0, Number(r.reset_ms)) };
  } catch (err) {
    dbFailed({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function dbPeek(key: string): Promise<Hit | null | undefined> {
  if (Date.now() < s.dbDownUntil) return undefined;
  try {
    const { data, error } = await db().rpc('rate_limit_peek', { p_key: keyHash(key) });
    if (error) { dbFailed(error); return undefined; }
    const r = firstRow(data);
    if (!r || r.count === null || r.count === undefined) return null;
    return { allowed: true, count: Number(r.count), resetMs: Math.max(0, Number(r.reset_ms)) };
  } catch (err) {
    dbFailed({ message: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

// ── Memory ───────────────────────────────────────────────────────────────────

function memoryHit(key: string, windowMs: number, limit: number): Hit {
  const now = Date.now();
  let e = s.memory.get(key);
  if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; s.memory.set(key, e); }
  e.count++;
  if (s.memory.size > 10_000) for (const [k, v] of s.memory) if (v.resetAt <= now) s.memory.delete(k);
  return { allowed: e.count <= limit, count: e.count, resetMs: e.resetAt - now };
}

function memoryPeek(key: string): Hit | null {
  const e = s.memory.get(key);
  if (!e || e.resetAt <= Date.now()) return null;
  return { allowed: true, count: e.count, resetMs: e.resetAt - Date.now() };
}

// ── API ──────────────────────────────────────────────────────────────────────

/** Counts one hit of `key`; allowed while the count in this window is at most `limit`. */
export async function hitLimit(key: string, windowMs: number, limit: number): Promise<Hit> {
  for (const st of stores()) {
    if (st === 'redis') { const r = await redisHit(key, windowMs, limit); if (r) return r; }
    else if (st === 'supabase') { const r = await dbHit(key, windowMs, limit); if (r) return r; }
    else return memoryHit(key, windowMs, limit);
  }
  return memoryHit(key, windowMs, limit);
}

/** The current window of `key` without counting a hit; null when there is none. */
export async function peekLimit(key: string): Promise<Hit | null> {
  for (const st of stores()) {
    if (st === 'redis') { const r = await redisPeek(key); if (r !== undefined) return r; }
    else if (st === 'supabase') { const r = await dbPeek(key); if (r !== undefined) return r; }
    else return memoryPeek(key);
  }
  return memoryPeek(key);
}

/** Forgets `key` (a successful sign-in clears its failures). */
export async function clearLimit(key: string): Promise<void> {
  s.memory.delete(key);
  for (const st of stores()) {
    if (st === 'redis') {
      const c = await redis();
      if (c) { try { await c.del(PREFIX + keyHash(key)); return; } catch (err) { redisDown(err); } }
    } else if (st === 'supabase' && Date.now() >= s.dbDownUntil) {
      try {
        const { error } = await db().from('rate_limits').delete().eq('key', keyHash(key));
        if (!error) return;
        dbFailed(error);
      } catch (err) {
        dbFailed({ message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
