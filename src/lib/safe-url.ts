import 'server-only';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

// Outgoing requests to addresses someone typed in (notification webhooks), which must never reach
// the worker's own network: loopback, private ranges, link-local and cloud metadata, CGNAT, unique
// local IPv6 and the rest of the non-public ranges, IPv4 inside IPv6 included. The host name is
// resolved and EVERY address it has must be public; the connection then goes to the address that
// was checked (no second lookup that a rebinding DNS server could answer differently). HTTPS only,
// no redirects followed. Errors given back are generic: the raw reason is logged, not returned.

export class UnsafeUrlError extends Error {}

// ── Addresses ────────────────────────────────────────────────────────────────

/** IPv4 ranges that are not public (CIDR). */
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT (also Alibaba's metadata 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
];

const v4ToInt = (ip: string) => ip.split('.').reduce((n, p) => (n * 256) + Number(p), 0);

function isPublicV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return !V4_BLOCKED.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = v4ToInt(base);
    return n >= start && n < start + size;
  });
}

/** The 16 bytes of an IPv6 address (any notation, embedded IPv4 included); null when malformed. */
function v6Bytes(ip: string): number[] | null {
  let s = ip;
  let tail: number[] = [];
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    tail = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h: string) => (h ? h.split(':') : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 255);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : null;
}

const startsWith = (b: number[], prefix: number[], bits: number) => {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3, bit = 7 - (i & 7);
    if (((b[byte] >> bit) & 1) !== ((prefix[byte] >> bit) & 1)) return false;
  }
  return true;
};
const v6 = (ip: string) => v6Bytes(ip)!;

/** IPv6 prefixes inside 2000::/3 that are still not public. */
const V6_BLOCKED: [number[], number][] = [
  [v6('2001::'), 23], // IETF protocol assignments (Teredo, ORCHID …)
  [v6('2001:db8::'), 32], // documentation
  [v6('2002::'), 16], // 6to4 (embeds any IPv4)
  [v6('3fff::'), 20], // documentation
];

function isPublicV6(ip: string): boolean {
  const b = v6Bytes(ip);
  if (!b) return false;
  const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judged by the IPv4 inside.
  if (startsWith(b, v6('::ffff:0:0'), 96) || startsWith(b, v6('64:ff9b::'), 96)) return isPublicV4(v4);
  // Global unicast only (2000::/3): excludes ::, ::1, IPv4-compatible ::a.b.c.d, 64:ff9b:1::/48,
  // 100::/64, fc00::/7 (unique local), fe80::/10 (link-local), fec0::/10, ff00::/8 (multicast).
  if (!startsWith(b, v6('2000::'), 3)) return false;
  return !V6_BLOCKED.some(([p, bits]) => startsWith(b, p, bits));
}

/** True only for a public unicast address (IPv4 or IPv6; anything unparsable is not). */
export function isPublicIp(ip: string): boolean {
  const a = ip.trim().replace(/^\[|\]$/g, '');
  if (a.includes('%')) return false; // a zone id: link-local
  if (net.isIPv4(a)) return isPublicV4(a);
  if (net.isIPv6(a)) return isPublicV6(a.toLowerCase());
  return false;
}

// ── Names and URLs ───────────────────────────────────────────────────────────

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet', '.corp', '.private'];

/**
 * The URL, when its shape is acceptable: https, no user name or password, a DNS host name (not an
 * IP address, not a local name). Says nothing about where the name points: see resolvePublic.
 */
export function checkUrlShape(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new UnsafeUrlError('not a full https:// address'); }
  if (u.protocol !== 'https:') throw new UnsafeUrlError('must start with https://');
  if (u.username || u.password) throw new UnsafeUrlError('must not contain a user name or password');
  // The URL parser already turned 0x7f.1, 2130706433 and the like into dotted IPv4.
  const h = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (!h || h.startsWith('[') || net.isIP(h) || /^[\d.]+$/.test(h) || h.includes(':')) throw new UnsafeUrlError('must use a public host name, not an IP address');
  if (h === 'localhost' || !h.includes('.') || LOCAL_SUFFIXES.some((s) => h.endsWith(s))) throw new UnsafeUrlError('must use a public host name, not a local name');
  return u;
}

export interface Resolved { address: string; family: 4 | 6 }

/** Resolves `host` and returns its addresses; throws unless there is at least one and EVERY one is public. */
export async function resolvePublic(host: string, lookup: typeof dns.promises.lookup = dns.promises.lookup): Promise<Resolved[]> {
  const name = host.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (net.isIP(name)) {
    if (!isPublicIp(name)) throw new UnsafeUrlError('points to a private or local address');
    return [{ address: name, family: net.isIPv6(name) ? 6 : 4 }];
  }
  let found: { address: string; family: number }[];
  try {
    found = await lookup(name, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError('host name could not be found');
  }
  if (!found.length) throw new UnsafeUrlError('host name could not be found');
  if (found.some((a) => !isPublicIp(a.address))) throw new UnsafeUrlError('points to a private or local address');
  return found.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

/** Shape and DNS checks together (when saving an address). */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = checkUrlShape(raw);
  await resolvePublic(u.hostname);
  return u;
}

// ── Sending ──────────────────────────────────────────────────────────────────

export interface SafePostResult { ok: boolean; status: number | null; error: string | null }

/**
 * POSTs `body` to `raw`, checked at send time (an address saved before is checked again: DNS may
 * have changed). Connects only to the addresses that were checked, keeps the host name for TLS
 * (certificate and SNI), never follows a redirect. `error` is generic; the reason is logged.
 */
export async function safePost(raw: string, body: string, opts: { headers?: Record<string, string>; timeoutMs?: number; label?: string } = {}): Promise<SafePostResult> {
  const label = opts.label ?? 'webhook';
  let u: URL;
  let addrs: Resolved[];
  try {
    u = checkUrlShape(raw);
    addrs = await resolvePublic(u.hostname);
  } catch (err) {
    console.warn(`[notify] ${label}: not sent, the address ${err instanceof Error ? err.message : 'is not allowed'}`);
    return { ok: false, status: null, error: 'The address is not a public HTTPS address' };
  }
  const host = u.hostname.replace(/\.+$/, '');
  const pick = addrs[0];
  return new Promise<SafePostResult>((resolve) => {
    let settled = false;
    const done = (r: SafePostResult) => { if (!settled) { settled = true; resolve(r); } };
    const req = https.request({
      method: 'POST',
      host,
      servername: host,
      port: u.port ? Number(u.port) : 443,
      path: `${u.pathname}${u.search}`,
      headers: { 'content-type': 'application/json', ...opts.headers, 'content-length': String(Buffer.byteLength(body)), host: u.host },
      agent: false,
      // The checked addresses, never a fresh lookup.
      lookup: ((_h: string, o: { all?: boolean }, cb: (...args: unknown[]) => void) => {
        if (o?.all) cb(null, addrs.map((a) => ({ address: a.address, family: a.family })));
        else cb(null, pick.address, pick.family);
      }) as unknown as net.LookupFunction,
      timeout: opts.timeoutMs ?? 15_000,
    }, (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      done(status >= 200 && status < 300 ? { ok: true, status, error: null } : { ok: false, status, error: status >= 300 && status < 400 ? `The address answered with a redirect (HTTP ${status}), which is not followed` : `The address answered HTTP ${status}` });
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', (err) => {
      console.warn(`[notify] ${label}: could not reach ${host} (${err.message})`);
      done({ ok: false, status: null, error: 'Could not reach the address' });
    });
    req.end(body);
  });
}
