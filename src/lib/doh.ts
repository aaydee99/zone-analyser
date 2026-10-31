import 'server-only';

// Public DNS lookups over DNS-over-HTTPS (JSON), for the DNS hygiene check and the onboarding page:
// what the internet sees (delegation, DS at the parent, whether a CNAME target exists). These go to
// Cloudflare's public resolver 1.1.1.1 (cloudflare-dns.com), not to the Cloudflare API: no token, no
// API budget. The names asked about leave the console, as they would with any resolver.
// Answers are cached by their TTL (negative answers by the SOA's), at most a few lookups run at once
// over the whole process, and each caller gets a cap (Lookups) so one zone with thousands of CNAMEs
// cannot hog it. DOH_URL points at another resolver (tests use a fake); DNS_HEALTH_DOH=off turns
// lookups off (they then read as "not checked").

const DOH_URL = () => process.env.DOH_URL?.trim() || 'https://cloudflare-dns.com/dns-query';
export const dohEnabled = () => (process.env.DNS_HEALTH_DOH ?? '').trim().toLowerCase() !== 'off';
const PARALLEL = 6;
const TIMEOUT_MS = 5_000;
const MAX_ENTRIES = 20_000;
const MIN_TTL_S = 60, MAX_TTL_S = 3_600, NEG_TTL_S = 900, ERROR_TTL_S = 30;

/** RCODEs: 0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN. -1: no answer (timeout, network, lookups off). */
export interface DohAnswer { status: number; answers: { name: string; type: number; ttl: number; data: string }[]; ad: boolean; /** The SOA TTL of a negative answer. */ negTtl?: number }
const TYPES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28, DS: 43, DNSKEY: 48 };

interface Entry { until: number; value: DohAnswer }
interface State { cache: Map<string, Entry>; inflight: Map<string, Promise<DohAnswer>>; running: number; waiting: (() => void)[]; lookups: number }
const g = globalThis as unknown as { __doh?: State };
const s: State = (g.__doh ??= { cache: new Map(), inflight: new Map(), running: 0, waiting: [], lookups: 0 });

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (s.running >= PARALLEL) await new Promise<void>((r) => s.waiting.push(r));
  s.running++;
  try { return await fn(); } finally { s.running--; s.waiting.shift()?.(); }
}

const NO_ANSWER: DohAnswer = { status: -1, answers: [], ad: false };

async function ask(name: string, type: string, cd: boolean): Promise<DohAnswer> {
  const u = new URL(DOH_URL());
  u.searchParams.set('name', name);
  u.searchParams.set('type', type);
  if (cd) u.searchParams.set('cd', '1');
  return slot(async () => {
    s.lookups++;
    try {
      const res = await fetch(u, { headers: { accept: 'application/dns-json' }, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return NO_ANSWER;
      const j = await res.json() as { Status?: number; AD?: boolean; Answer?: { name?: string; type?: number; TTL?: number; data?: string }[]; Authority?: { TTL?: number }[] };
      return {
        status: typeof j.Status === 'number' ? j.Status : -1, ad: !!j.AD,
        answers: (j.Answer ?? []).map((a) => ({ name: String(a.name ?? ''), type: Number(a.type ?? 0), ttl: Number(a.TTL ?? 0), data: String(a.data ?? '') })),
        negTtl: j.Authority?.[0]?.TTL,
      };
    } catch { return NO_ANSWER; }
  });
}

/** How long an answer is kept: its records' TTL, a negative answer's SOA TTL, a failure briefly. */
function ttlOf(a: DohAnswer): number {
  if (a.status === -1 || a.status === 2) return ERROR_TTL_S;
  if (a.answers.length) return Math.max(MIN_TTL_S, Math.min(MAX_TTL_S, Math.min(...a.answers.map((x) => x.ttl || MIN_TTL_S))));
  return Math.max(MIN_TTL_S, Math.min(NEG_TTL_S, a.negTtl ?? NEG_TTL_S));
}

/** One lookup (cached). `cd`: checking disabled — the answer even when DNSSEC validation fails. */
export async function resolve(name: string, type: keyof typeof TYPES, cd = false): Promise<DohAnswer> {
  if (!dohEnabled()) return NO_ANSWER;
  const key = `${type}:${cd ? 1 : 0}:${name.toLowerCase().replace(/\.$/, '')}`;
  const hit = s.cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const running = s.inflight.get(key);
  if (running) return running;
  const p = ask(name, type, cd).then((a) => {
    if (s.cache.size >= MAX_ENTRIES) { const first = s.cache.keys().next().value; if (first !== undefined) s.cache.delete(first); }
    s.cache.set(key, { until: Date.now() + ttlOf(a) * 1000, value: a });
    return a;
  }).finally(() => { s.inflight.delete(key); });
  s.inflight.set(key, p);
  return p;
}

/** The answers of one type ("NS" data, "DS" data …), lower-case without trailing dots for names. */
export const dataOf = (a: DohAnswer, type: keyof typeof TYPES) => a.answers.filter((x) => x.type === TYPES[type]).map((x) => (type === 'NS' || type === 'CNAME' ? x.data.toLowerCase().replace(/\.$/, '') : x.data));

/** A cap on the lookups one caller (one zone's run) may make; answers from the cache are free. */
export class Lookups {
  used = 0;
  skipped = 0;
  constructor(public readonly max: number) {}
  async resolve(name: string, type: keyof typeof TYPES, cd = false): Promise<DohAnswer | null> {
    const key = `${type}:${cd ? 1 : 0}:${name.toLowerCase().replace(/\.$/, '')}`;
    const hit = s.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    if (this.used >= this.max) { this.skipped++; return null; }
    this.used++;
    return resolve(name, type, cd);
  }
}

/** Lookups sent since the process started (for tests and the timing report). */
export const dohLookups = () => s.lookups;
