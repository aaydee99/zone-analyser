// Host and scheme rules shared by the request proxy and the API wrappers. No imports,
// so the proxy can load it without pulling in the database client.

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]',]);

const hostname = (h: string) => (h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]);

/** Loopback names on any port: traffic to these never leaves the machine. */
export function isLoopbackHost(host: string | null): boolean {
  return !!host && LOOPBACK_HOSTNAMES.has(hostname(host.trim().toLowerCase()));
}

/**
 * Hosts the console answers to: any host, unless CONSOLE_ALLOWED_HOSTS lists some (comma-separated
 * host[:port]); then only those and the loopback names on any port. `*` in the list also allows any host.
 */
export function isAllowedHost(host: string | null): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  const listed = (process.env.CONSOLE_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!listed.length || listed.includes('*')) return true;
  return listed.includes(h) || isLoopbackHost(h);
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
 * Loopback requests are exempt off Vercel (the worker calls its own server on 127.0.0.1); on Vercel
 * nothing is reached over loopback, so there is no exemption to abuse.
 * Several secrets separated by commas are all accepted: rotate by adding the new one, switching the
 * CDN to it, then removing the old one (no request is refused in between).
 */
export function cameThroughCdn(host: string | null, headers: Headers): boolean {
  const secrets = (process.env.CONSOLE_ORIGIN_SECRET ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!secrets.length) return true;
  if (!process.env.VERCEL && isLoopbackHost(host)) return true;
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
