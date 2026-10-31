// Host and scheme rules shared by the request proxy and the API wrappers. No imports,
// so the proxy can load it without pulling in the database client.

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]',]);

const hostname = (h: string) => (h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]);

/** Loopback names on any port. Only a NAME: anyone can send `Host: 127.0.0.1`, so this alone proves nothing (see isLocalRequest). */
export function isLoopbackHost(host: string | null): boolean {
  return !!host && LOOPBACK_HOSTNAMES.has(hostname(host.trim().toLowerCase()));
}

// ── Requests from this machine ────────────────────────────────────────────────
// The Host header is chosen by the client, so `Host: 127.0.0.1` sent to a server that listens on
// 0.0.0.0 (a container, `-H 0.0.0.0`) must not count as "from this machine". Next.js does not
// expose the socket's address to the proxy or the routes, so a request counts as local only when:
//  - it carries this process's own random token (LOCAL_HEADER) — the worker loop's replays of
//    relayed calls send it; it never leaves the process, and changes on every start; or
//  - the server is bound to a 127.x address only (`next dev|start -H 127.0.0.1`, as package.json
//    does), so nothing outside the machine can reach it at all.

/** The header carrying this process's token on its own calls to itself. */
export const LOCAL_HEADER = 'x-console-local';

const gt = globalThis as unknown as { __consoleLocalToken?: string };

/** This process's token for calls to its own server (random, made on first use, kept in memory only). */
export function localToken(): string {
  if (!gt.__consoleLocalToken) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    gt.__consoleLocalToken = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return gt.__consoleLocalToken;
}

/** Headers for a call this process makes to its own server. */
export const localRequestHeaders = (): Record<string, string> => ({ [LOCAL_HEADER]: localToken() });

/** True when the request carries this process's own token. */
export function hasLocalToken(headers: Headers): boolean {
  const sent = headers.get(LOCAL_HEADER)?.trim();
  return !!sent && sameSecret(sent, localToken());
}

// Read by name at run time (never inlined at build time).
const NEXT_ORIGIN_VAR = '__NEXT_PRIVATE_ORIGIN';

/**
 * True only when the server listens on a 127.x address and nothing else. Next.js records the address
 * it bound to (its -H value) once listening; with no -H, 0.0.0.0 or `::` it records "localhost" or
 * "[::1]", which cannot be told apart from an open bind, so those count as NOT loopback-only.
 * CONSOLE_LISTEN_HOST (scripts/worker.mjs) set to anything else also turns it off.
 */
export function listensOnLoopbackOnly(): boolean {
  const env = process.env as Record<string, string | undefined>;
  const listen = env.CONSOLE_LISTEN_HOST?.trim();
  if (listen && !/^127(\.\d{1,3}){3}$/.test(listen)) return false;
  let bound = '';
  try { bound = new URL(env[NEXT_ORIGIN_VAR] ?? '').hostname; } catch { return false; }
  return /^127(\.\d{1,3}){3}$/.test(bound);
}

/**
 * A request from this machine: a loopback Host AND (this process's token, or a server that only
 * listens on loopback). Never on Vercel, where nothing is reached over loopback.
 */
export function isLocalRequest(host: string | null, headers: Headers): boolean {
  if (process.env.VERCEL || !isLoopbackHost(host)) return false;
  return hasLocalToken(headers) || listensOnLoopbackOnly();
}

/**
 * Hosts the console answers to: any host, unless CONSOLE_ALLOWED_HOSTS lists some (comma-separated
 * host[:port]); then only those, and the loopback names for requests from this machine (isLocalRequest:
 * pass the request's headers). `*` in the list also allows any host.
 */
export function isAllowedHost(host: string | null, headers?: Headers): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  const listed = (process.env.CONSOLE_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!listed.length || listed.includes('*')) return true;
  return listed.includes(h) || (!!headers && isLocalRequest(h, headers));
}

/** Header the CDN in front of the console adds with CONSOLE_ORIGIN_SECRET (CONSOLE_ORIGIN_HEADER renames it). */
export const originHeader = () => process.env.CONSOLE_ORIGIN_HEADER?.trim().toLowerCase() || 'x-console-origin-auth';

/** Compares in time that depends only on the lengths, so the secret cannot be guessed byte by byte. */
function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

/**
 * With CONSOLE_ORIGIN_SECRET set, only requests that came through the CDN (which adds the secret
 * header) are served, so nobody can skip its WAF and rate limits by calling the origin directly.
 * Requests from this machine are exempt (isLocalRequest: the worker calls its own server on
 * 127.0.0.1 with its token); a bare `Host: 127.0.0.1` is not.
 * Several secrets separated by commas are all accepted: rotate by adding the new one, switching the
 * CDN to it, then removing the old one (no request is refused in between).
 */
export function cameThroughCdn(host: string | null, headers: Headers): boolean {
  const secrets = (process.env.CONSOLE_ORIGIN_SECRET ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!secrets.length) return true;
  if (isLocalRequest(host, headers)) return true;
  const sent = headers.get(originHeader())?.trim();
  return !!sent && secrets.some((s) => sameSecret(sent, s));
}

/**
 * True when the browser reached us over HTTPS, directly or through the TLS proxy in
 * front of it. The console only listens on 127.0.0.1, so X-Forwarded-Proto can only
 * come from a process on this machine.
 */
export function isHttpsRequest(url: string, headers: Headers): boolean {
  return new URL(url).protocol === 'https:' || headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
}
