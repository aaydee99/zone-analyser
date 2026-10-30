import 'server-only';
import { inBackground, type Progress } from './bg-job';
import { cached, cacheBackend } from './cache';
import { HttpError } from './http';
import { credentialForRun } from './vault';
import { listZones } from './zone-explorer';
import type { ZoneListItem } from './zone-catalog';
import { csvFile } from './zone-format';
import { EMPTY_TOTALS, type StatusClass, type TrafficCountry, type TrafficDay, type TrafficPending, type TrafficReport, type TrafficSlice, type TrafficTotals, type TrafficZone } from './traffic-types';

// Monthly traffic analysis: one month of HTTP traffic for the account (or the one zone of it) someone
// chooses, from Cloudflare's GraphQL Analytics API (httpRequests1dGroups: one row per zone and day),
// added up for the account. Only the chosen zones are queried. Read-only: the only call is a fixed GraphQL *query*
// (POST is how GraphQL takes it); zone IDs and dates are checked before they go into it.
// Each token needs "Zone › Analytics › Read"; zones it cannot read are listed, not hidden.

export const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
/** Zones per query. */
const BATCH = 10;
const PARALLEL = 4;
const MONTHS = 12;
export const RUNNING_TTL = 15 * 60_000;
export const CLOSED_TTL = 6 * 60 * 60_000;
const TOP_COUNTRIES = 10;

const FULL_FIELDS = 'sum { requests cachedRequests bytes cachedBytes threats pageViews countryMap { clientCountryName requests bytes threats } responseStatusMap { edgeResponseStatus requests } } uniq { uniques }';
const BASIC_FIELDS = 'sum { requests cachedRequests bytes cachedBytes threats pageViews } uniq { uniques }';

// ── Months ──────────────────────────────────────────────────────────────────

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const monthOf = (d: Date) => d.toISOString().slice(0, 7);
const firstOf = (month: string) => new Date(`${month}-01T00:00:00Z`);
const addMonths = (month: string, n: number) => { const d = firstOf(month); d.setUTCMonth(d.getUTCMonth() + n); return monthOf(d); };

/** The last twelve months, this one first. */
export function trafficMonths(now = new Date()): string[] {
  const cur = monthOf(now);
  return Array.from({ length: MONTHS }, (_, i) => addMonths(cur, -i));
}

/** First day, the day after the last one with data (today counts), and whether the month is still running. */
export function rangeOf(month: string, now = new Date()) {
  const next = firstOf(addMonths(month, 1));
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const until = next < tomorrow ? next : tomorrow;
  return { since: `${month}-01`, until: ymd(until), partial: next > tomorrow, days: Math.round((until.getTime() - firstOf(month).getTime()) / 86_400_000) };
}

// ── Cloudflare GraphQL ──────────────────────────────────────────────────────

export interface GqlError { message?: string; path?: unknown[]; extensions?: { code?: string } }
interface Group {
  dimensions?: { date?: string };
  sum?: {
    requests?: number; cachedRequests?: number; bytes?: number; cachedBytes?: number; threats?: number; pageViews?: number;
    countryMap?: { clientCountryName?: string; requests?: number; bytes?: number; threats?: number }[];
    responseStatusMap?: { edgeResponseStatus?: number; requests?: number }[];
  };
  uniq?: { uniques?: number };
}
interface GqlAnswer { status: number; zones: { zoneTag?: string; httpRequests1dGroups?: Group[] }[] | null; errors: GqlError[] }

async function query(token: string, text: string): Promise<GqlAnswer> {
  try {
    const res = await fetch(GRAPHQL, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text }), signal: AbortSignal.timeout(60_000), cache: 'no-store',
    });
    const body = (await res.json().catch(() => null)) as { data?: { viewer?: { zones?: GqlAnswer['zones'] } } | null; errors?: GqlError[] | null } | null;
    return { status: res.status, zones: body?.data?.viewer?.zones ?? null, errors: body?.errors ?? (res.ok ? [] : [{ message: `HTTP ${res.status}` }]) };
  } catch {
    return { status: 0, zones: null, errors: [{ message: 'Could not reach the Cloudflare API' }] };
  }
}

/** Zone IDs as the zone list has them; nothing that could leave the GraphQL string. */
const ZONE_TAG = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function zonesQuery(tags: string[], since: string, until: string, fields: string) {
  if (!tags.every((t) => ZONE_TAG.test(t)) || !DATE.test(since) || !DATE.test(until)) throw new HttpError(400, 'Invalid zone or date');
  return `{ viewer { zones(filter: { zoneTag_in: [${tags.map((t) => `"${t}"`).join(', ')}] }) { zoneTag `
    + `httpRequests1dGroups(limit: 62, filter: { date_geq: "${since}", date_lt: "${until}" }, orderBy: [date_ASC]) { dimensions { date } ${fields} } } } }`;
}

/** An error message, or (when Cloudflare sends none) its code or the error itself, so the cause is never hidden. */
const textOf = (e: GqlError) => e.message || (e.extensions?.code ? `Cloudflare error code ${e.extensions.code}` : Object.keys(e ?? {}).length ? `Cloudflare returned ${JSON.stringify(e).slice(0, 300)}` : '');
export const errorText = (errors: GqlError[]) => [...new Set(errors.map(textOf).filter(Boolean))].join('; ') || 'Cloudflare returned an error';
/** The breakdown fields are unknown to this API (schema change): fall back to the totals. */
const schemaError = (errors: GqlError[]) => errors.some((e) => /unknown field|cannot query field|not defined|does not exist|undefined field/i.test(e.message ?? ''));
export const permissionError = (errors: GqlError[], status: number) => status === 401 || status === 403 || errors.some((e) => /not authori[sz]ed|permission|access/i.test(e.message ?? ''));

// ── One month of raw numbers, per zone (cached) ─────────────────────────────

interface RawZone { status: TrafficZone['status']; message?: string; daily: TrafficDay[]; statuses: Record<StatusClass, number> | null; countries: Record<string, TrafficCountry> }
interface RawMonth { generatedAt: string; detail: 'full' | 'basic'; zones: Record<string, RawZone>; problems: { credential: string; error: string }[] }

const failed = (status: TrafficZone['status'], message: string): RawZone => ({ status, message, daily: [], statuses: null, countries: {} });

function parseZone(groups: Group[], detail: 'full' | 'basic'): RawZone {
  const statuses: Record<StatusClass, number> = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  const countries: Record<string, TrafficCountry> = {};
  const daily = groups.filter((g) => g.dimensions?.date).map((g) => {
    const s = g.sum ?? {};
    for (const x of s.responseStatusMap ?? []) {
      const cls = `${Math.floor((x.edgeResponseStatus ?? 0) / 100)}xx` as StatusClass;
      if (cls in statuses) statuses[cls] += x.requests ?? 0;
    }
    for (const x of s.countryMap ?? []) {
      const name = x.clientCountryName || 'Unknown';
      const c = (countries[name] ??= { country: name, requests: 0, bytes: 0, threats: 0 });
      c.requests += x.requests ?? 0; c.bytes += x.bytes ?? 0; c.threats += x.threats ?? 0;
    }
    return {
      date: g.dimensions!.date!, requests: s.requests ?? 0, cachedRequests: s.cachedRequests ?? 0, bytes: s.bytes ?? 0,
      cachedBytes: s.cachedBytes ?? 0, threats: s.threats ?? 0, pageViews: s.pageViews ?? 0, uniques: g.uniq?.uniques ?? 0,
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { status: 'ok', daily, statuses: detail === 'full' ? statuses : null, countries };
}

/**
 * Reads a batch of zones with one token. A failing batch is split in halves until each error is down
 * to its own zone, so a few zones without analytics access cost a few extra queries, not one per zone.
 */
async function readZones(token: string, tags: string[], since: string, until: string, state: { detail: 'full' | 'basic' }): Promise<Record<string, RawZone>> {
  let r = await query(token, zonesQuery(tags, since, until, state.detail === 'full' ? FULL_FIELDS : BASIC_FIELDS));
  if (state.detail === 'full' && schemaError(r.errors)) {
    state.detail = 'basic';
    r = await query(token, zonesQuery(tags, since, until, BASIC_FIELDS));
  }
  if (r.errors.length && !r.zones?.length && tags.length > 1) {
    const half = Math.ceil(tags.length / 2);
    const parts = await Promise.all([tags.slice(0, half), tags.slice(half)].map((t) => readZones(token, t, since, until, state)));
    return Object.assign({}, ...parts);
  }
  const out: Record<string, RawZone> = {};
  for (const tag of tags) {
    const z = r.zones?.find((x) => x.zoneTag?.toLowerCase() === tag.toLowerCase());
    if (z) out[tag] = parseZone(z.httpRequests1dGroups ?? [], state.detail);
    else if (r.errors.length) {
      out[tag] = permissionError(r.errors, r.status)
        ? failed('unavailable', `The token cannot read this zone's analytics — it needs "Zone › Analytics › Read" (${errorText(r.errors)})`)
        : failed('error', errorText(r.errors));
    } else out[tag] = parseZone([], state.detail); // no traffic at all
  }
  return out;
}

export async function inParallel<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** What is read: one account (all of its zones) or one zone of it. Only these zones are ever queried. */
export interface Scope {
  accountId: string;
  accountName: string;
  zoneId?: string;
  zones: ZoneListItem[];
  credentialOf: Record<string, { id: string; name: string }>;
}
const scopeKey = (s: Pick<Scope, 'accountId' | 'zoneId'>) => `account=${encodeURIComponent(s.accountId)}${s.zoneId ? `&zone=${encodeURIComponent(s.zoneId)}` : ''}`;

/** The account (and zone) from the cached zone list — no Cloudflare call. */
export async function scopeOf(accountId: string, zoneId?: string): Promise<Scope> {
  if (!accountId) throw new HttpError(400, 'Choose an account');
  const list = await listZones();
  const inAccount = list.zones.filter((z) => z.accountId === accountId);
  if (!inAccount.length) throw new HttpError(404, 'No stored token can read zones in this account');
  if (zoneId && !inAccount.some((z) => z.id === zoneId)) throw new HttpError(404, 'This zone is not in that account');
  return {
    accountId, accountName: inAccount[0].accountName || accountId, ...(zoneId ? { zoneId } : {}),
    zones: zoneId ? inAccount.filter((z) => z.id === zoneId) : inAccount, credentialOf: list.credentialOf,
  };
}

function readMonth(month: string, scope: Scope, fresh: boolean, progress: Progress = { done: 0, total: 0 }): Promise<RawMonth> {
  const { since, until, partial } = rangeOf(month);
  return cached(`path:/api/traffic?month=${month}&${scopeKey(scope)}`, partial ? RUNNING_TTL : CLOSED_TTL, async () => {
    // The scope's zones grouped by the stored credential that reads them; each token is decrypted once.
    const byCredential = new Map<string, string[]>();
    for (const z of scope.zones) {
      const c = scope.credentialOf[z.id];
      if (c && ZONE_TAG.test(z.id)) byCredential.set(c.id, [...(byCredential.get(c.id) ?? []), z.id]);
    }
    const state = { detail: 'full' as 'full' | 'basic' };
    const zones: Record<string, RawZone> = {};
    const problems: RawMonth['problems'] = [];
    const jobs: { token: string; tags: string[] }[] = [];
    for (const [id, tags] of byCredential) {
      let token = '';
      try { token = (await credentialForRun(id, 'cloudflare')).fields.apiToken; } catch { /* below */ }
      if (!token) {
        problems.push({ credential: Object.values(scope.credentialOf).find((c) => c.id === id)?.name ?? id, error: 'Could not be decrypted' });
        for (const t of tags) zones[t] = failed('error', 'The stored credential for this zone could not be decrypted');
        continue;
      }
      for (let i = 0; i < tags.length; i += BATCH) jobs.push({ token, tags: tags.slice(i, i + BATCH) });
    }
    progress.total += jobs.length;
    const parts = await inParallel(jobs, PARALLEL, async (j) => {
      try { return await readZones(j.token, j.tags, since, until, state); } finally { progress.done++; }
    });
    for (const part of parts) Object.assign(zones, part);
    return { generatedAt: new Date().toISOString(), detail: state.detail, zones, problems };
  }, fresh);
}

// ── Adding up ───────────────────────────────────────────────────────────────

function totalsOf(days: TrafficDay[]): TrafficTotals {
  const t = { ...EMPTY_TOTALS };
  for (const d of days) {
    t.requests += d.requests; t.cachedRequests += d.cachedRequests; t.bytes += d.bytes; t.cachedBytes += d.cachedBytes;
    t.threats += d.threats; t.pageViews += d.pageViews; t.uniquesSum += d.uniques;
  }
  t.days = days.length;
  return t;
}

function mergeDays(lists: TrafficDay[][]): TrafficDay[] {
  const by = new Map<string, TrafficDay>();
  for (const d of lists.flat()) {
    const cur = by.get(d.date);
    if (!cur) { by.set(d.date, { ...d }); continue; }
    cur.requests += d.requests; cur.cachedRequests += d.cachedRequests; cur.bytes += d.bytes; cur.cachedBytes += d.cachedBytes;
    cur.threats += d.threats; cur.pageViews += d.pageViews; cur.uniques += d.uniques;
  }
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function mergeStatuses(list: (Record<StatusClass, number> | null)[]): Record<StatusClass, number> | null {
  const have = list.filter((x): x is Record<StatusClass, number> => !!x);
  if (!have.length) return null;
  const out: Record<StatusClass, number> = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  for (const s of have) for (const k of Object.keys(out) as StatusClass[]) out[k] += s[k];
  return out;
}

function mergeCountries(list: Record<string, TrafficCountry>[]): Record<string, TrafficCountry> {
  const out: Record<string, TrafficCountry> = {};
  for (const m of list) for (const c of Object.values(m)) {
    const o = (out[c.country] ??= { country: c.country, requests: 0, bytes: 0, threats: 0 });
    o.requests += c.requests; o.bytes += c.bytes; o.threats += c.threats;
  }
  return out;
}

const topCountries = (m: Record<string, TrafficCountry>) => Object.values(m).sort((a, b) => b.requests - a.requests).slice(0, TOP_COUNTRIES);

/** The same stretch of the previous month: all of it, or its first `days` days while this month runs. */
function previousOf(prev: RawMonth | null, ids: string[], days: number | null): TrafficTotals | null {
  if (!prev) return null;
  const readable = ids.map((id) => prev.zones[id]).filter((z) => z?.status === 'ok');
  if (!readable.length) return null;
  const cut = (d: TrafficDay) => days === null || Number(d.date.slice(8, 10)) <= days;
  return totalsOf(mergeDays(readable.map((z) => z.daily.filter(cut))));
}

function slice(raws: RawZone[], prev: RawMonth | null, ids: string[], days: number | null): TrafficSlice {
  const ok = raws.filter((z) => z.status === 'ok');
  const daily = mergeDays(ok.map((z) => z.daily));
  return { totals: totalsOf(daily), previous: previousOf(prev, ids, days), daily, statuses: mergeStatuses(ok.map((z) => z.statuses)), countries: topCountries(mergeCountries(ok.map((z) => z.countries))) };
}

/** How long a request waits for a read before answering "still reading" (202); see bg-job.ts. */
export const WAIT_MS = 20_000;

/**
 * GET /api/traffic?month=YYYY-MM&account=ID[&zone=ID]: one account's month (its zones added up, and each
 * zone), or one zone's — or how far reading it got. Nothing outside the chosen account or zone is read.
 */
export async function trafficReport(month: string, accountId: string, zoneId?: string, fresh = false, waitMs = WAIT_MS): Promise<TrafficReport | TrafficPending> {
  const months = trafficMonths();
  if (!months.includes(month)) throw new HttpError(400, `Pick a month from the last ${MONTHS} (YYYY-MM)`);
  const scope = await scopeOf(accountId, zoneId || undefined);
  const out = await inBackground(`traffic:${month}&${scopeKey(scope)}`, (progress) => buildReport(month, scope, fresh, months, progress), waitMs);
  return 'pending' in out ? { ...out, month, accountId: scope.accountId, ...(scope.zoneId ? { zoneId: scope.zoneId } : {}) } : out;
}

async function buildReport(month: string, scope: Scope, fresh: boolean, months: string[], progress: Progress): Promise<TrafficReport> {
  const asked = Date.now();
  const { since, until, partial, days } = rangeOf(month);
  // Both months at once; the previous one only feeds the comparison, so if it cannot be read there is none.
  const [raw, prev] = await Promise.all([
    readMonth(month, scope, fresh, progress),
    readMonth(addMonths(month, -1), scope, false, progress).catch(() => null),
  ]);
  const span = partial ? days : null;

  const zones: TrafficZone[] = scope.zones.filter((z) => raw.zones[z.id]).map((z) => {
    const r = raw.zones[z.id];
    return { id: z.id, name: z.name, plan: z.plan, status: r.status, ...(r.message ? { message: r.message } : {}), ...slice([r], prev, [z.id], span) };
  }).sort((a, b) => b.totals.requests - a.totals.requests || a.name.localeCompare(b.name));
  const ids = zones.map((z) => z.id);
  const zone = scope.zoneId ? scope.zones[0] : undefined;

  return {
    month, since, until, partial, generatedAt: raw.generatedAt, detail: raw.detail, months,
    scope: { accountId: scope.accountId, accountName: scope.accountName, ...(zone ? { zoneId: zone.id, zoneName: zone.name } : {}) },
    ...(Date.parse(raw.generatedAt) < asked ? { cachedIn: cacheBackend() } : {}),
    ...slice(ids.map((id) => raw.zones[id]), prev, ids, span),
    zones, unavailable: zones.filter((z) => z.status !== 'ok').length, problems: raw.problems,
  };
}

// ── CSV ─────────────────────────────────────────────────────────────────────

const pct = (part: number, whole: number) => (whole ? ((part / whole) * 100).toFixed(1) : '');
const change = (now: number, before: number | undefined) => (before ? (((now - before) / before) * 100).toFixed(1) : '');

/** GET /api/traffic/export.csv?month=YYYY-MM&account=ID[&zone=ID]: one row per zone. */
export function trafficCsv(r: TrafficReport): string {
  const head = ['Account', 'Zone', 'Plan', 'Status', 'Requests', 'Cached requests', 'Cached %', 'Bandwidth (bytes)', 'Cached bandwidth (bytes)', 'Threats', 'Page views',
    'Avg. daily visitors', '2xx', '3xx', '4xx', '5xx', 'Previous requests', 'Change %', 'Note'];
  const rows = r.zones.map((z) => [
    r.scope.accountName, z.name, z.plan, z.status, z.totals.requests, z.totals.cachedRequests, pct(z.totals.cachedRequests, z.totals.requests), z.totals.bytes, z.totals.cachedBytes,
    z.totals.threats, z.totals.pageViews, z.totals.days ? Math.round(z.totals.uniquesSum / z.totals.days) : 0,
    z.statuses?.['2xx'] ?? '', z.statuses?.['3xx'] ?? '', z.statuses?.['4xx'] ?? '', z.statuses?.['5xx'] ?? '',
    z.previous?.requests ?? '', change(z.totals.requests, z.previous?.requests), z.message ?? '',
  ]);
  return csvFile([head, ...rows]);
}
