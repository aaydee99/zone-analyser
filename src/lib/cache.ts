import 'server-only';
import crypto from 'node:crypto';
import { createClient } from 'redis';

// Shared cache for Cloudflare reads, so pages load from the cache instead of calling the API again.
// With REDIS_URL set it lives in Redis (shared by every console process and kept across restarts);
// without it, in this process's memory. Values in Redis are sealed with AES-256-GCM under a key
// derived from the vault server key: Redis only ever holds ciphertext. Tokens are never cached.
// Any Redis failure falls back to memory — the cache can make a page faster, never break it.

const PREFIX = `${process.env.REDIS_PREFIX?.trim() || 'backup-console'}:`;
const MEMORY_MAX = 300;
const RETRY_MS = 30_000;

type Client = ReturnType<typeof createClient>;
interface State {
  memory: Map<string, { until: number; value: unknown }>;
  inflight: Map<string, Promise<unknown>>;
  client: Client | null;
  connecting: Promise<Client | null> | null;
  downUntil: number;
  key: Buffer | null;
}
const g = globalThis as unknown as { __cache?: State };
const s: State = (g.__cache ??= { memory: new Map(), inflight: new Map(), client: null, connecting: null, downUntil: 0, key: null });

const redisUrl = () => process.env.REDIS_URL?.trim() || '';

/** Where cached data lives right now. */
export function cacheBackend(): 'redis' | 'memory' {
  return redisUrl() && s.client?.isReady ? 'redis' : 'memory';
}

async function redis(): Promise<Client | null> {
  if (!redisUrl() || Date.now() < s.downUntil) return null;
  if (s.client?.isReady) return s.client;
  s.connecting ??= (async () => {
    try {
      if (!s.key) s.key = await (await import('./vault')).cacheKeyMaterial();
      const c = createClient({ url: redisUrl(), socket: { connectTimeout: 3000, reconnectStrategy: false } });
      c.on('error', (err) => down(err));
      await c.connect();
      s.client = c;
      return c;
    } catch (err) {
      down(err);
      return null;
    } finally {
      s.connecting = null;
    }
  })();
  return s.connecting;
}

/** Redis is unavailable: use memory and try again in a while. Logs the reason, never the URL. */
function down(err: unknown) {
  if (Date.now() >= s.downUntil) console.error('[cache] Redis unavailable, using memory for now:', err instanceof Error ? err.message.replace(/\/\/[^@\s]*@/g, '//') : err);
  s.downUntil = Date.now() + RETRY_MS;
  const c = s.client;
  s.client = null;
  if (c?.isOpen) c.destroy();
}

function seal(name: string, value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', s.key!, iv);
  cipher.setAAD(Buffer.from(name));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function unseal(name: string, text: string): unknown {
  const b = Buffer.from(text, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', s.key!, b.subarray(0, 12));
  d.setAAD(Buffer.from(name));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}

async function read<T>(name: string): Promise<T | undefined> {
  const c = await redis();
  if (c) {
    let text: string | null = null;
    try { text = await c.get(PREFIX + name); } catch (err) { down(err); }
    if (s.client) {
      if (!text) return undefined;
      // A value sealed under another server key (or garbled) is a miss.
      try { return unseal(name, text) as T; } catch { return undefined; }
    }
  }
  const hit = s.memory.get(name);
  if (!hit) return undefined;
  if (Date.now() > hit.until) { s.memory.delete(name); return undefined; }
  return hit.value as T;
}

async function write(name: string, value: unknown, ttlMs: number) {
  const c = await redis();
  if (c) {
    try { await c.set(PREFIX + name, seal(name, value), { expiration: { type: 'PX', value: ttlMs } }); return; } catch (err) { down(err); }
  }
  s.memory.delete(name);
  s.memory.set(name, { until: Date.now() + ttlMs, value });
  while (s.memory.size > MEMORY_MAX) s.memory.delete(s.memory.keys().next().value!);
}

/**
 * The cached value for `name`, or `load()`'s result (then cached for `ttlMs`, or for what `ttlMs(value)` says). Concurrent callers
 * share one load. `fresh` skips the cached value and replaces it. Values must be plain JSON.
 */
export async function cached<T>(name: string, ttlMs: number | ((value: T) => number), load: () => Promise<T>, fresh = false): Promise<T> {
  if (!fresh) {
    const hit = await read<T>(name);
    if (hit !== undefined) return hit;
  }
  const running = s.inflight.get(name);
  if (running) return running as Promise<T>;
  const p = (async () => {
    try {
      const value = await load();
      await write(name, value, typeof ttlMs === 'function' ? ttlMs(value) : ttlMs);
      return value;
    } finally {
      s.inflight.delete(name);
    }
  })();
  s.inflight.set(name, p);
  return p;
}

/** A short, one-way tag for a secret (e.g. a token) in a cache name: a changed token is a new name. */
export const tag = (secret: string) => crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);

/** Drops every cached value whose name starts with one of `prefixes` (in Redis and in memory). */
export async function uncache(...prefixes: string[]) {
  for (const k of [...s.memory.keys()]) if (prefixes.some((p) => k.startsWith(p))) s.memory.delete(k);
  const c = await redis();
  if (!c) return;
  try {
    for (const p of prefixes) {
      for await (const keys of c.scanIterator({ MATCH: `${PREFIX}${p.replace(/[*?[\]\\]/g, '\\$&')}*`, COUNT: 200 })) {
        if (keys.length) await c.del(keys);
      }
    }
  } catch (err) {
    down(err);
  }
}
