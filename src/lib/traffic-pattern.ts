import 'server-only';
import { tokenForAccount, tokenForZone } from './account-token';
import { inBackground, type Progress } from './bg-job';
import { cached, cacheBackend } from './cache';
import { cfCall, cfReason } from './cf-read';
import { HttpError } from './http';
import { analyse, type PatternAnalysis, type Point } from './traffic-anomaly';
import { scopeOf } from './traffic';

// The last 30 days of HTTP traffic hour by hour, and the last 24 hours in 5-minute steps, for one
// account (all of its zones) or one zone — the input of the pattern and spike analysis
// (traffic-anomaly.ts). One dataset, httpRequestsOverviewAdaptiveGroups, at account level
// (viewer.accounts) or zone level (viewer.zones), so an account with thousands of zones costs the
// same few queries as one zone. It counts every request whatever its status code: requests, those
// served from cache, and their bytes. Read-only: GraphQL queries through cf-read.ts (the per-token
// budget). How far back and how long one query's range may be come from the dataset's settings;
// days the plan does not keep are left out and said so, never estimated. Kept for CACHE_MS.

const CACHE_MS = 10 * 60_000;
const DAYS = 30;
const DAY_MS = 86_400_000;
/** Ranges asked for in one query (each its own alias). */
const ALIASES = 8;
const FIELDS = 'sum { requests cachedRequests bytes cachedBytes }';
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface PatternReport extends PatternAnalysis {
  scope: { accountId: string; accountName: string; zoneId?: string; zoneName?: string };
  generatedAt: string;
  cachedIn?: 'redis' | 'memory';
  /** Hours and 5-minute points read, and what could not be read. */
  coverage: { hourlySince: string | null; hourlyPoints: number; fineSince: string | null; finePoints: number; notes: string[] };
  /** Queries sent (as GraphQL text) so each number can be reproduced. */
  queries: number;
}
export interface PatternPending { pending: true; job: string; done: number; total: number; startedAt: string }

interface Limits { maxDuration: number; notOlderThan: number; maxPageSize: number; enabled: boolean }
type G = { sum?: { requests?: number; cachedRequests?: number; bytes?: number; cachedBytes?: number }; dimensions?: Record<string, string> };

async function gql<T>(token: string, query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<{ data: T | null; errors: string[] }> {
  const r = await cfCall<T>(token, 'POST', '/graphql', { query, variables }, signal);
  const body = r.body as unknown as { data?: T | null; errors?: { message?: string }[] | null } | null;
  if (r.status === 401 || r.status === 403) return { data: null, errors: [`the token cannot read analytics (${cfReason(r)})`] };
  if (!body) return { data: null, errors: [cfReason(r)] };
  return { data: body.data ?? null, errors: (body.errors ?? []).map((e) => e.message ?? '').filter(Boolean) };
}

/** Where the dataset is read: the account, or one zone. */
const node = (zone: boolean) => (zone ? 'zones(filter: { zoneTag: $tag })' : 'accounts(filter: { accountTag: $tag })');

async function limitsOf(token: string, tag: string, zone: boolean, signal?: AbortSignal): Promise<Limits> {
  const fallback: Limits = { maxDuration: DAY_MS / 1000, notOlderThan: (DAYS + 1) * 86_400, maxPageSize: 1_000, enabled: true };
  const r = await gql<{ viewer?: { zones?: { settings?: { httpRequestsOverviewAdaptiveGroups?: Partial<Limits> } }[]; accounts?: { settings?: { httpRequestsOverviewAdaptiveGroups?: Partial<Limits> } }[] } }>(token,
    `query ($tag: String!) { viewer { ${node(zone)} { settings { httpRequestsOverviewAdaptiveGroups { enabled maxDuration notOlderThan maxPageSize } } } } }`, { tag }, signal).catch(() => null);
  const s = (zone ? r?.data?.viewer?.zones : r?.data?.viewer?.accounts)?.[0]?.settings?.httpRequestsOverviewAdaptiveGroups;
  return s ? { enabled: s.enabled !== false, maxDuration: Number(s.maxDuration) || fallback.maxDuration, notOlderThan: Number(s.notOlderThan) || fallback.notOlderThan, maxPageSize: Number(s.maxPageSize) || fallback.maxPageSize } : fallback;
}

/** [since, until) cut into parts no longer than the dataset allows and holding at most `perPage` points. */
function partsOf(since: number, until: number, l: Limits, stepMs: number) {
  const len = Math.max(stepMs, Math.min(l.maxDuration * 1000, Math.floor(Math.min(l.maxPageSize, 1_000) * 0.9) * stepMs, DAY_MS));
  const out: { since: string; until: string }[] = [];
  for (let t = until; t > since; t -= len) out.push({ since: new Date(Math.max(since, t - len)).toISOString(), until: new Date(t).toISOString() });
  return out.reverse();
}

/** Reads `parts` with `dim` (datetimeHour or datetimeFiveMinutes), ALIASES at a time; parts that fail are noted, never filled in. */
async function series(token: string, tag: string, zone: boolean, dim: string, parts: { since: string; until: string }[], progress: Progress, notes: string[], count: () => void, signal?: AbortSignal): Promise<{ points: Point[]; failed: { since: string; until: string }[] }> {
  const by = new Map<string, Point>();
  const failed: { since: string; until: string }[] = [];
  let reason = '';
  for (let i = 0; i < parts.length; i += ALIASES) {
    signal?.throwIfAborted();
    const chunk = parts.slice(i, i + ALIASES);
    const vars: Record<string, string> = { tag };
    const decl = ['$tag: String!'];
    const fields = chunk.map((p, k) => {
      vars[`s${k}`] = p.since; vars[`u${k}`] = p.until; decl.push(`$s${k}: Time!`, `$u${k}: Time!`);
      return `p${k}: httpRequestsOverviewAdaptiveGroups(limit: 1000, filter: { datetime_geq: $s${k}, datetime_lt: $u${k} }, orderBy: [${dim}_ASC]) { ${FIELDS} dimensions { ${dim} } }`;
    });
    count();
    const r = await gql<{ viewer?: Record<string, Record<string, G[] | null>[]> }>(token, `query (${decl.join(', ')}) { viewer { ${node(zone)} { ${fields.join(' ')} } } }`, vars, signal);
    progress.done++;
    const at = r.data?.viewer?.[zone ? 'zones' : 'accounts']?.[0];
    chunk.forEach((part, k) => {
      const rows = at?.[`p${k}`];
      if (!rows) { failed.push(part); reason ||= r.errors[0] ?? 'no data returned'; return; }
      for (const g of rows) {
        const t = g.dimensions?.[dim];
        if (!t) continue;
        const iso = new Date(t).toISOString();
        const cur = by.get(iso) ?? { t: iso, requests: 0, cached: 0, bytes: 0, cachedBytes: 0 };
        cur.requests += g.sum?.requests ?? 0; cur.cached += g.sum?.cachedRequests ?? 0; cur.bytes += g.sum?.bytes ?? 0; cur.cachedBytes += g.sum?.cachedBytes ?? 0;
        by.set(iso, cur);
      }
    });
  }
  if (failed.length) notes.push(`${failed.length} of ${parts.length} ${dim === 'datetimeHour' ? 'parts of the 30 days' : 'parts of the last 24 hours'} could not be read: ${reason}`);
  return { points: [...by.values()].sort((a, b) => a.t.localeCompare(b.t)), failed };
}

/** Every step of [since, until) with zero where Cloudflare returned no row (no traffic in that step). */
function fill(points: Point[], since: number, until: number, stepMs: number, readable: (t: number) => boolean): Point[] {
  const by = new Map(points.map((p) => [Date.parse(p.t), p]));
  const out: Point[] = [];
  for (let t = since; t < until; t += stepMs) if (readable(t)) out.push(by.get(t) ?? { t: new Date(t).toISOString(), requests: 0, cached: 0, bytes: 0, cachedBytes: 0 });
  return out;
}

async function build(accountId: string, zoneId: string | undefined, progress: Progress): Promise<PatternReport> {
  const scope = await scopeOf(accountId, zoneId);
  const zone = !!scope.zoneId;
  const tag = scope.zoneId ?? scope.accountId;
  if (!ID.test(tag)) throw new HttpError(400, 'Invalid account or zone');
  const token = zone ? (await tokenForZone(scope.zoneId!)).token : await tokenForAccount(scope.accountId);
  let queries = 0;
  const count = () => { queries++; };
  const notes: string[] = [];
  count();
  const l = await limitsOf(token, tag, zone, progress.signal);
  if (!l.enabled) throw new HttpError(409, `Cloudflare does not offer request analytics (httpRequestsOverviewAdaptiveGroups) for this ${zone ? 'zone' : 'account'}`);

  const now = Date.now();
  // Complete steps only: the current hour and 5 minutes are still filling up.
  const hourEnd = Math.floor(now / 3_600_000) * 3_600_000;
  const fineEnd = Math.floor(now / 300_000) * 300_000;
  const oldest = now - l.notOlderThan * 1000 + 3_600_000;
  const hourSince = Math.max(hourEnd - DAYS * DAY_MS, Math.ceil(oldest / 3_600_000) * 3_600_000);
  if (hourSince > hourEnd - DAYS * DAY_MS) notes.push(`Cloudflare keeps this data for ${Math.round(l.notOlderThan / 86_400)} days on this plan: the pattern uses ${Math.round((hourEnd - hourSince) / DAY_MS)} days.`);
  const hourParts = partsOf(hourSince, hourEnd, l, 3_600_000);
  const fineSince = Math.max(fineEnd - DAY_MS, Math.ceil(oldest / 300_000) * 300_000);
  const fineParts = partsOf(fineSince, fineEnd, l, 300_000);
  progress.total += Math.ceil(hourParts.length / ALIASES) + Math.ceil(fineParts.length / ALIASES);

  const hourNotes: string[] = [], fineNotes: string[] = [];
  const [hr, fr] = await Promise.all([
    series(token, tag, zone, 'datetimeHour', hourParts, progress, hourNotes, count, progress.signal),
    series(token, tag, zone, 'datetimeFiveMinutes', fineParts, progress, fineNotes, count, progress.signal),
  ]);
  notes.push(...hourNotes, ...fineNotes);
  // Steps inside a part that failed are left out (unknown), never counted as zero.
  const readable = (failed: { since: string; until: string }[]) => (t: number) => !failed.some((p) => t >= Date.parse(p.since) && t < Date.parse(p.until));
  const hourly = fill(hr.points, hourSince, hourEnd, 3_600_000, readable(hr.failed));
  const fine = fr.failed.length === fineParts.length ? [] : fill(fr.points, fineSince, fineEnd, 300_000, readable(fr.failed));
  const a = analyse(hourly, fine, new Date(fineEnd), { ...(hourNotes[0] ? { hourly: hourNotes[0] } : {}), ...(fineNotes[0] ? { fine: fineNotes[0] } : {}) });
  const z = zone ? scope.zones[0] : undefined;
  return {
    ...a,
    scope: { accountId: scope.accountId, accountName: scope.accountName, ...(z ? { zoneId: z.id, zoneName: z.name } : {}) },
    generatedAt: new Date().toISOString(),
    coverage: { hourlySince: hourly[0]?.t ?? null, hourlyPoints: hourly.length, fineSince: fine[0]?.t ?? null, finePoints: fine.length, notes },
    queries,
  };
}

/** GET /api/traffic/patterns?account=ID[&zone=ID]: the analysis, or how far reading it got (202). */
export async function trafficPatterns(accountId: string, zoneId: string | undefined, fresh: boolean, waitMs = 20_000): Promise<PatternReport | PatternPending> {
  const key = `path:/api/traffic/patterns?account=${encodeURIComponent(accountId)}${zoneId ? `&zone=${encodeURIComponent(zoneId)}` : ''}`;
  const asked = Date.now();
  const out = await inBackground(`pattern:${key}`, (progress) => cached(key, CACHE_MS, () => build(accountId, zoneId, progress), fresh), waitMs, { fresh });
  if ('pending' in out) return out;
  return Date.parse(out.generatedAt) < asked - 1_000 ? { ...out, cachedIn: cacheBackend() } : out;
}
