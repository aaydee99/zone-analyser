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

/**
 * True when the browser reached us over HTTPS, directly or through the TLS proxy in
 * front of it. The console only listens on 127.0.0.1, so X-Forwarded-Proto can only
 * come from a process on this machine.
 */
export function isHttpsRequest(url: string, headers: Headers): boolean {
  return new URL(url).protocol === 'https:' || headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
}
