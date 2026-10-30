import 'server-only';
import { inBackground, type Pending, type Progress } from './bg-job';
import { cached, cacheBackend } from './cache';
import { HttpError } from './http';
import { CLOSED_TTL, GRAPHQL, RUNNING_TTL, WAIT_MS, errorText, inParallel, permissionError, rangeOf, scopeOf, trafficMonths, type GqlError } from './traffic';
import type { DatasetDetail, DetailFilter, DetailRow, FirewallEvent, ZoneDetail, ZoneDetailPending } from './traffic-types';
import { credentialForRun } from './vault';
import { rulesetNames } from './zone-explorer';

// Zone detail for traffic analytics: one zone's security events (which WAF / managed / custom /
// rate-limiting rules matched, what they did, which IPs, paths, countries …) and its requests (top
// IPs, paths, status codes, cache status …), from Cloudflare's adaptive GraphQL datasets
// (firewallEventsAdaptiveGroups, firewallEventsAdaptive, httpRequestsAdaptiveGroups). Read only for
// the zone someone chose, optionally narrowed to one IP or one rule.
//
// Cloudflare limits these datasets per zone plan, and says how in its `settings` node: how far back
// (notOlderThan), how long one query's range may be (maxDuration), how many fields one query may use,
// and which fields the plan offers. The month is read in parts of maxDuration, every breakdown of a
// part in as few queries as the field limit allows; breakdowns the plan does not offer are left out.
// Every value in a query is a JSON string literal (valid GraphQL), so nothing can leave its string.

const MAX_PARTS = 12;
const PARALLEL = 3;
const EVENTS = 100;
const DEFAULT_LIMITS = { enabled: true, maxDuration: 259_200, notOlderThan: 2_678_400, maxNumberOfFields: 25, maxPageSize: 10_000, availableFields: null as string[] | null };
type Limits = typeof DEFAULT_LIMITS;

const J = (v: string) => JSON.stringify(v);

interface Spec { alias: string; dims: string[]; limit: number; bytes?: boolean }

/** WAF / firewall events, grouped. */
const SECURITY_SPECS: Spec[] = [
  { alias: 'daily', dims: ['date'], limit: 40 },
  { alias: 'actions', dims: ['action'], limit: 25 },
  { alias: 'sources', dims: ['source'], limit: 30 },
  { alias: 'rules', dims: ['ruleId', 'rulesetId', 'description', 'source', 'action'], limit: 200 },
  { alias: 'ips', dims: ['clientIP', 'clientCountryName', 'clientASNDescription'], limit: 200 },
  { alias: 'paths', dims: ['clientRequestPath'], limit: 100 },
  { alias: 'hosts', dims: ['clientRequestHTTPHost'], limit: 50 },
  { alias: 'countries', dims: ['clientCountryName'], limit: 50 },
  { alias: 'asns', dims: ['clientAsn', 'clientASNDescription'], limit: 50 },
  { alias: 'userAgents', dims: ['userAgent'], limit: 50 },
  { alias: 'methods', dims: ['clientRequestHTTPMethodName'], limit: 15 },
];

/** All HTTP requests, grouped (with bytes). */
const REQUEST_SPECS: Spec[] = [
  { alias: 'daily', dims: ['date'], limit: 40, bytes: true },
  { alias: 'ips', dims: ['clientIP', 'clientCountryName', 'clientASNDescription'], limit: 200, bytes: true },
  { alias: 'paths', dims: ['clientRequestPath'], limit: 100, bytes: true },
  { alias: 'hosts', dims: ['clientRequestHTTPHost'], limit: 50, bytes: true },
  { alias: 'statuses', dims: ['edgeResponseStatus'], limit: 50 },
  { alias: 'cache', dims: ['cacheStatus'], limit: 20, bytes: true },
  { alias: 'methods', dims: ['clientRequestHTTPMethodName'], limit: 15 },
  { alias: 'countries', dims: ['clientCountryName'], limit: 50, bytes: true },
  { alias: 'asns', dims: ['clientAsn', 'clientASNDescription'], limit: 50, bytes: true },
  { alias: 'userAgents', dims: ['userAgent'], limit: 50 },
  { alias: 'browsers', dims: ['userAgentBrowser'], limit: 20 },
  { alias: 'devices', dims: ['clientDeviceType'], limit: 10 },
  { alias: 'protocols', dims: ['clientRequestHTTPProtocol'], limit: 10 },
];

/** Shown per breakdown, after the parts are added up. */
const SHOW: Record<string, number> = { rules: 100, ips: 100, paths: 50 };

const EVENT_FIELDS = ['datetime', 'action', 'source', 'ruleId', 'rulesetId', 'description', 'clientIP', 'clientCountryName', 'clientAsn', 'clientASNDescription',
  'clientRequestHTTPMethodName', 'clientRequestHTTPHost', 'clientRequestPath', 'clientRequestQuery', 'userAgent', 'edgeResponseStatus', 'rayName'];
const EVENT_FIELDS_MIN = ['datetime', 'action', 'source', 'ruleId', 'description', 'clientIP', 'clientRequestPath'];

// ── GraphQL ─────────────────────────────────────────────────────────────────

interface Answer { status: number; data: Record<string, unknown> | null; errors: GqlError[] }

async function gql(token: string, text: string): Promise<Answer> {
  try {
    const res = await fetch(GRAPHQL, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text }), signal: AbortSignal.timeout(60_000), cache: 'no-store',
    });
    const body = (await res.json().catch(() => null)) as { data?: { viewer?: { zones?: Record<string, unknown>[] } } | null; errors?: GqlError[] | null } | null;
    return { status: res.status, data: body?.data?.viewer?.zones?.[0] ?? null, errors: body?.errors ?? (res.ok ? [] : [{ message: `HTTP ${res.status}` }]) };
  } catch {
    return { status: 0, data: null, errors: [{ message: 'Could not reach the Cloudflare API' }] };
  }
}

const zoneQuery = (zoneId: string, body: string) => `{ viewer { zones(filter: { zoneTag: ${J(zoneId)} }) { ${body} } } }`;

// ── What the zone's plan allows ─────────────────────────────────────────────

const DATASETS = ['firewallEventsAdaptiveGroups', 'firewallEventsAdaptive', 'httpRequestsAdaptiveGroups'] as const;
type Dataset = (typeof DATASETS)[number];

async function limitsOf(token: string, zoneId: string): Promise<Record<Dataset, Limits>> {
  const ask = (fields: string) => gql(token, zoneQuery(zoneId, `settings { ${DATASETS.map((d) => `${d} { ${fields} }`).join(' ')} }`));
  let r = await ask('enabled maxDuration notOlderThan maxNumberOfFields maxPageSize availableFields');
  if (r.errors.length) r = await ask('enabled maxDuration notOlderThan maxNumberOfFields maxPageSize');
  const settings = (r.data?.settings ?? {}) as Partial<Record<Dataset, Partial<Limits> | null>>;
  return Object.fromEntries(DATASETS.map((d) => {
    const s = settings[d];
    return [d, {
      enabled: s ? s.enabled !== false : DEFAULT_LIMITS.enabled,
      maxDuration: Number(s?.maxDuration) > 0 ? Number(s!.maxDuration) : DEFAULT_LIMITS.maxDuration,
      notOlderThan: Number(s?.notOlderThan) > 0 ? Number(s!.notOlderThan) : DEFAULT_LIMITS.notOlderThan,
      maxNumberOfFields: Number(s?.maxNumberOfFields) > 0 ? Number(s!.maxNumberOfFields) : DEFAULT_LIMITS.maxNumberOfFields,
      maxPageSize: Number(s?.maxPageSize) > 0 ? Number(s!.maxPageSize) : DEFAULT_LIMITS.maxPageSize,
      availableFields: Array.isArray(s?.availableFields) && s!.availableFields!.length ? s!.availableFields!.map(String) : null,
    }];
  })) as Record<Dataset, Limits>;
}

/** Fields the plan offers (names or paths ending in the name). With no list, everything is tried. */
function offered(limits: Limits, field: string) {
  const list = limits.availableFields;
  return !list || list.some((f) => f === field || f.endsWith(`.${field}`) || f.endsWith(`/${field}`));
}

// ── Reading one dataset over the month ──────────────────────────────────────

/** The part of the month this dataset still has, in parts of at most maxDuration. */
function windowOf(month: string, limits: Limits, now = Date.now()) {
  const { since, until } = rangeOf(month, new Date(now));
  const end = Math.min(Date.parse(`${until}T00:00:00Z`), now);
  const keptFrom = now - limits.notOlderThan * 1000 + 60_000;
  let start = Math.max(Date.parse(`${since}T00:00:00Z`), keptFrom);
  const step = limits.maxDuration * 1000;
  let trimmed = false;
  if (end - start > step * MAX_PARTS) { start = end - step * MAX_PARTS; trimmed = true; }
  const parts: { since: string; until: string }[] = [];
  for (let t = start; t < end; t += step) parts.push({ since: new Date(t).toISOString(), until: new Date(Math.min(t + step, end)).toISOString() });
  return { parts, since: parts.length ? new Date(start).toISOString() : undefined, until: parts.length ? new Date(end).toISOString() : undefined, trimmed };
}

/** Breakdowns packed into queries of at most maxNumberOfFields fields (dimensions, count and bytes each count). */
function pack(specs: Spec[], maxFields: number): Spec[][] {
  const out: Spec[][] = [];
  let cur: Spec[] = [];
  let n = 0;
  for (const s of specs) {
    const w = s.dims.length + 1 + (s.bytes ? 1 : 0);
    if (cur.length && n + w > maxFields) { out.push(cur); cur = []; n = 0; }
    cur.push(s); n += w;
  }
  if (cur.length) out.push(cur);
  return out;
}

const filterOf = (dataset: Dataset, f: DetailFilter | null) =>
  f?.ip ? `, clientIP: ${J(f.ip)}` : f?.rule && dataset !== 'httpRequestsAdaptiveGroups' ? `, ruleId: ${J(f.rule)}` : '';

function groupsQuery(dataset: Dataset, zoneId: string, part: { since: string; until: string }, specs: Spec[], f: DetailFilter | null, pageSize: number) {
  return zoneQuery(zoneId, specs.map((s) =>
    `${s.alias}: ${dataset}(limit: ${Math.min(s.limit, pageSize)}, filter: { datetime_geq: ${J(part.since)}, datetime_lt: ${J(part.until)}${filterOf(dataset, f)} }, orderBy: [count_DESC]) `
    + `{ count ${s.bytes ? 'sum { edgeResponseBytes } ' : ''}dimensions { ${s.dims.join(' ')} } }`).join(' '));
}

interface Group { count?: number; sum?: { edgeResponseBytes?: number }; dimensions?: Record<string, unknown> }

/** One query; a failing query is split until each failure is down to one breakdown, which is then left out. */
async function readGroups(token: string, dataset: Dataset, zoneId: string, part: { since: string; until: string }, specs: Spec[], f: DetailFilter | null,
  limits: Limits, failed: Map<string, string>): Promise<Record<string, Group[]>> {
  const live = specs.filter((s) => !failed.has(s.alias));
  if (!live.length) return {};
  const r = await gql(token, groupsQuery(dataset, zoneId, part, live, f, limits.maxPageSize));
  if (r.errors.length && !r.data) {
    if (live.length > 1) {
      const half = Math.ceil(live.length / 2);
      const parts = await Promise.all([live.slice(0, half), live.slice(half)].map((x) => readGroups(token, dataset, zoneId, part, x, f, limits, failed)));
      return Object.assign({}, ...parts);
    }
    failed.set(live[0].alias, errorText(r.errors));
    return {};
  }
  return Object.fromEntries(live.map((s) => [s.alias, Array.isArray(r.data?.[s.alias]) ? (r.data![s.alias] as Group[]) : []]));
}

function addUp(into: Map<string, DetailRow>, groups: Group[]) {
  for (const g of groups) {
    const dims = Object.fromEntries(Object.entries(g.dimensions ?? {}).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]));
    const key = JSON.stringify(dims);
    const row = into.get(key) ?? { dims, count: 0 };
    row.count += g.count ?? 0;
    if (g.sum?.edgeResponseBytes !== undefined) row.bytes = (row.bytes ?? 0) + g.sum.edgeResponseBytes;
    into.set(key, row);
  }
}

const days = (seconds: number) => Math.round(seconds / 86_400);

async function readDataset(token: string, dataset: Dataset, zoneId: string, month: string, all: Spec[], f: DetailFilter | null, limits: Limits, progress: Progress): Promise<DatasetDetail> {
  const base: DatasetDetail = { available: false, notes: [], retentionDays: days(limits.notOlderThan), parts: 0, total: 0, breakdowns: {} };
  if (!limits.enabled) return { ...base, message: "Not available on this zone's plan" };
  const w = windowOf(month, limits);
  if (!w.parts.length) return { ...base, message: `Cloudflare keeps this for ${days(limits.notOlderThan)} days on this zone's plan — choose a more recent month` };
  const specs = all.filter((s) => s.dims.every((d) => offered(limits, d)));
  const notOffered = all.filter((s) => !specs.includes(s)).map((s) => s.alias);
  const queries = pack(specs, Math.max(3, limits.maxNumberOfFields));
  progress.total += w.parts.length * queries.length;

  const failed = new Map<string, string>();
  const merged = new Map<string, Map<string, DetailRow>>(specs.map((s) => [s.alias, new Map()]));
  const jobs = w.parts.flatMap((part) => queries.map((q) => ({ part, q })));
  const answers = await inParallel(jobs, PARALLEL, async (j) => {
    try { return await readGroups(token, dataset, zoneId, j.part, j.q, f, limits, failed); } finally { progress.done++; }
  });
  for (const a of answers) for (const [alias, groups] of Object.entries(a)) addUp(merged.get(alias)!, groups);

  const ok = specs.filter((s) => !failed.has(s.alias));
  if (!ok.length) {
    const errs = [...failed.values()].map((m) => ({ message: m }));
    return { ...base, message: permissionError(errs, 0) ? `The token cannot read this — it needs "Zone › Analytics › Read" (${errorText(errs)})` : errorText(errs) };
  }
  const breakdowns = Object.fromEntries(ok.map((s) => {
    const rows = [...merged.get(s.alias)!.values()].sort((a, b) => (s.alias === 'daily' ? a.dims.date.localeCompare(b.dims.date) : b.count - a.count));
    return [s.alias, s.alias === 'daily' ? rows : rows.slice(0, SHOW[s.alias] ?? 25)];
  }));
  const notes: string[] = [];
  if (w.trimmed) notes.push(`Covers the last ${days((Date.parse(w.until!) - Date.parse(w.since!)) / 1000)} days of the month (read in at most ${MAX_PARTS} parts)`);
  if (notOffered.length) notes.push(`Not offered on this zone's plan: ${notOffered.join(', ')}`);
  for (const [alias, msg] of failed) notes.push(`${alias} could not be read: ${msg}`);
  const total = (breakdowns.daily ?? breakdowns.actions ?? breakdowns.statuses ?? []).reduce((n, r) => n + r.count, 0);
  return { available: true, notes, retentionDays: days(limits.notOlderThan), since: w.since, until: w.until, parts: w.parts.length, total, breakdowns };
}

/** The latest individual security events (newest part of the month only). */
async function readEvents(token: string, zoneId: string, month: string, f: DetailFilter | null, limits: Limits): Promise<{ events: FirewallEvent[]; since?: string; note?: string }> {
  if (!limits.enabled) return { events: [], note: "Single events are not available on this zone's plan" };
  const w = windowOf(month, limits);
  const last = w.parts[w.parts.length - 1];
  if (!last) return { events: [] };
  const ask = (fields: string[]) => gql(token, zoneQuery(zoneId,
    `events: firewallEventsAdaptive(limit: ${Math.min(EVENTS, limits.maxPageSize)}, filter: { datetime_geq: ${J(last.since)}, datetime_lt: ${J(last.until)}${filterOf('firewallEventsAdaptive', f)} }, orderBy: [datetime_DESC]) { ${fields.join(' ')} }`));
  let r = await ask(EVENT_FIELDS.filter((x) => offered(limits, x)));
  if (r.errors.length && !r.data) r = await ask(EVENT_FIELDS_MIN.filter((x) => offered(limits, x)));
  if (r.errors.length && !r.data) return { events: [], note: `Single events could not be read: ${errorText(r.errors)}` };
  return { events: Array.isArray(r.data?.events) ? (r.data!.events as FirewallEvent[]) : [], since: last.since };
}

// ── The zone detail ─────────────────────────────────────────────────────────

const IP = /^[0-9A-Fa-f:.]{2,45}$/;
const RULE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * GET /api/traffic/detail?month=YYYY-MM&account=ID&zone=ID[&ip=…|&rule=…]: the zone's security events and
 * requests for the month (as far back as its plan keeps them), or how far reading got.
 */
export async function zoneDetail(month: string, accountId: string, zoneId: string, filter: DetailFilter, fresh = false, waitMs = WAIT_MS): Promise<ZoneDetail | ZoneDetailPending> {
  if (!trafficMonths().includes(month)) throw new HttpError(400, 'Pick a month from the last 12 (YYYY-MM)');
  if (!zoneId) throw new HttpError(400, 'Choose a zone: the detail is read for one zone');
  if (filter.ip && !IP.test(filter.ip)) throw new HttpError(400, 'Not an IP address');
  if (filter.rule && !RULE.test(filter.rule)) throw new HttpError(400, 'Not a rule ID');
  if (filter.ip && filter.rule) throw new HttpError(400, 'Narrow to an IP or a rule, not both');
  const scope = await scopeOf(accountId, zoneId);
  const zone = scope.zones[0];
  const f: DetailFilter | null = filter.ip ? { ip: filter.ip } : filter.rule ? { rule: filter.rule } : null;
  const key = `month=${month}&zone=${encodeURIComponent(zoneId)}${f?.ip ? `&ip=${encodeURIComponent(f.ip)}` : ''}${f?.rule ? `&rule=${encodeURIComponent(f.rule)}` : ''}`;
  const { partial } = rangeOf(month);

  const out = await inBackground<ZoneDetail>(`detail:${key}`, async (progress) => {
    const asked = Date.now();
    const d = await cached(`path:/api/traffic/detail?${key}`, partial ? RUNNING_TTL : CLOSED_TTL, async (): Promise<ZoneDetail> => {
      const cred = scope.credentialOf[zoneId];
      let token = '';
      try { token = cred ? (await credentialForRun(cred.id, 'cloudflare')).fields.apiToken : ''; } catch { /* below */ }
      if (!token) throw new HttpError(409, 'The stored credential for this zone could not be decrypted');
      progress.total += 1;
      const limits = await limitsOf(token, zoneId).finally(() => { progress.done++; });
      const [security, requests, events, names] = await Promise.all([
        readDataset(token, 'firewallEventsAdaptiveGroups', zoneId, month, SECURITY_SPECS.filter((s) => !(f?.ip && s.alias === 'ips') && !(f?.rule && s.alias === 'rules')), f, limits.firewallEventsAdaptiveGroups, progress),
        f?.rule
          ? Promise.resolve<DatasetDetail>({ available: false, message: 'Requests are not linked to rules', notes: [], retentionDays: null, parts: 0, total: 0, breakdowns: {} })
          : readDataset(token, 'httpRequestsAdaptiveGroups', zoneId, month, REQUEST_SPECS.filter((s) => !(f?.ip && s.alias === 'ips')), f, limits.httpRequestsAdaptiveGroups, progress),
        readEvents(token, zoneId, month, f, limits.firewallEventsAdaptive),
        rulesetNames(zoneId).catch(() => ({} as Record<string, string>)),
      ]);
      if (events.note) security.notes.push(events.note);
      return {
        month, zoneId, zoneName: zone.name, accountName: scope.accountName, filter: f,
        security: { ...security, events: events.events, ...(events.since ? { eventsSince: events.since } : {}) },
        requests, rulesetNames: names, generatedAt: new Date().toISOString(),
      };
    }, fresh);
    return Date.parse(d.generatedAt) < asked ? { ...d, cachedIn: cacheBackend() } : d;
  }, waitMs);
  return 'pending' in out ? { ...(out as Pending), month, zoneId, filter: f } : out;
}
