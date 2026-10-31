import 'server-only';
import { inBackground, type Pending, type Progress } from './bg-job';
import { tag } from './cache';
import { HttpError } from './http';
import { GRAPHQL, WAIT_MS, errorText, inParallel, permissionError, rangeOf, readAnswer, scopeOf, trafficMonths, trafficReport, type GqlError, type Scope } from './traffic';
import type { DatasetDetail, DetailFilter, DetailRow, DetailZone, FirewallEvent, ManagedDeployment, ZoneDetail, ZoneDetailPending } from './traffic-types';
import { CACHED_STATUSES as CACHED, DETAIL_VIEWS, MANAGED_RULESETS, MITIGATING_ACTIONS as THREAT_ACTIONS, OWASP_ANOMALY_RULE, OWASP_RULESET, SECURITY_VIEWS } from './traffic-types';
import { credentialForRun } from './vault';
import { rulesetNames } from './zone-explorer';

// Zone detail for traffic analytics: one zone's security events (which WAF / managed / custom /
// rate-limiting rules matched, what they did, which IPs, paths, countries …) and its requests (top
// IPs, paths, status codes, cache status …), from Cloudflare's adaptive GraphQL datasets
// (firewallEventsAdaptiveGroups, firewallEventsAdaptive, httpRequestsAdaptiveGroups). Read only for
// the zone someone chose (or an account's busiest zones, added up), optionally narrowed to one IP or one rule.
//
// Cloudflare limits these datasets per zone plan, and says how in its `settings` node: how far back
// (notOlderThan), how long one query's range may be (maxDuration), how many fields one query may use,
// and which fields the plan offers. The month is read in parts of maxDuration, every breakdown of a
// part in as few queries as the field limit allows; breakdowns the plan does not offer are left out.
// Every value in a query is a JSON string literal (valid GraphQL), so nothing can leave its string.

const MAX_PARTS = 12;
const PARALLEL = 3;
/** Single events and requests shown: more as the window gets smaller. */
const listSize = (f: DetailFilter | null) => (f?.hour !== undefined ? 1000 : f?.day ? 500 : 100);
const DEFAULT_LIMITS = { enabled: true, maxDuration: 259_200, notOlderThan: 2_678_400, maxNumberOfFields: 25, maxPageSize: 10_000, availableFields: null as string[] | null };
type Limits = typeof DEFAULT_LIMITS;

const J = (v: string) => JSON.stringify(v);

interface Spec { alias: string; dims: string[]; limit: number; bytes?: boolean }

/** WAF / firewall events, grouped. */
const SECURITY_SPECS: Spec[] = [
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

/** The time series of a window: per day for the month, per hour for a day, per minute for an hour. */
export const TIME_DIM: Record<string, string> = { daily: 'date', hourly: 'datetimeHour', minutes: 'datetimeMinute' };
function timeSpec(f: DetailFilter | null, bytes: boolean): Spec {
  if (f?.hour !== undefined) return { alias: 'minutes', dims: ['datetimeMinute'], limit: 70, bytes };
  if (f?.day) return { alias: 'hourly', dims: ['datetimeHour'], limit: 30, bytes };
  return { alias: 'daily', dims: ['date'], limit: 40, bytes };
}
const timeRowsOf = (b: Record<string, DetailRow[]>) => b.daily ?? b.hourly ?? b.minutes;
/** Security events over time by action (for the chart's mitigated / not mitigated split). */
function timeActionsSpec(f: DetailFilter | null): Spec {
  const t = timeSpec(f, false);
  return { alias: 'timeActions', dims: [t.dims[0], 'action'], limit: t.limit * 15 };
}
/** Requests over time by cache status (for the chart's cache / origin split). */
function timeCacheSpec(f: DetailFilter | null): Spec {
  const t = timeSpec(f, false);
  return { alias: 'timeCache', dims: [t.dims[0], 'cacheStatus'], limit: t.limit * 12 };
}

/** Shown per breakdown, after the parts are added up. */
const SHOW: Record<string, number> = { rules: 250, ips: 100, paths: 50, timeActions: 5000, timeCache: 5000 };

const EVENT_FIELDS = ['datetime', 'action', 'source', 'ruleId', 'rulesetId', 'description', 'clientIP', 'clientCountryName', 'clientAsn', 'clientASNDescription',
  'clientRequestHTTPMethodName', 'clientRequestHTTPHost', 'clientRequestPath', 'clientRequestQuery', 'userAgent', 'edgeResponseStatus', 'rayName'];
const EVENT_FIELDS_MIN = ['datetime', 'action', 'source', 'ruleId', 'description', 'clientIP', 'clientRequestPath'];
const REQUEST_FIELDS = ['datetime', 'clientIP', 'clientCountryName', 'clientASNDescription', 'clientRequestHTTPMethodName', 'clientRequestHTTPHost', 'clientRequestPath',
  'clientRequestQuery', 'clientRequestHTTPProtocol', 'edgeResponseStatus', 'cacheStatus', 'edgeResponseBytes', 'userAgent', 'rayName'];
const REQUEST_FIELDS_MIN = ['datetime', 'clientIP', 'clientRequestPath', 'edgeResponseStatus'];

// ── GraphQL ─────────────────────────────────────────────────────────────────

interface Answer { status: number; data: Record<string, unknown> | null; errors: GqlError[] }
/** One GraphQL query for a zone read (with the read's token and progress). */
type Ask = (text: string) => Promise<Answer>;

// Cloudflare allows about 300 GraphQL queries per 5 minutes per user. Queries for one token wait
// for room under a budget below that, and when Cloudflare still says the budget is spent, they
// wait for it to refill and try once more, instead of failing (or splitting into more queries).
// TRAFFIC_GQL_BUDGET lowers (or raises) the budget, e.g. when other tools share the token.
const WINDOW_MS = Number(process.env.TRAFFIC_GQL_WINDOW_MS) || 300_000;
const BUDGET = Number(process.env.TRAFFIC_GQL_BUDGET) || 240;
const COOL_MS = Number(process.env.TRAFFIC_GQL_COOL_MS) || 300_000;
interface Budget { sent: number[]; coolUntil: number; queue: Promise<void> }
const gb = globalThis as unknown as { __gqlBudgets?: Map<string, Budget> };
const budgets = (gb.__gqlBudgets ??= new Map());
function budgetOf(token: string) {
  const k = tag(token);
  let b = budgets.get(k);
  if (!b) budgets.set(k, (b = { sent: [], coolUntil: 0, queue: Promise.resolve() }));
  return b;
}
const utcTime = (t: number) => `${new Date(t).toISOString().slice(11, 16)} UTC`;
const LIMITED = /budget|rate.?limit|too many (requests|queries)|quota|limit exceeded/i;
const isLimited = (a: Answer) => a.status === 429 || a.errors.some((e) => LIMITED.test(`${e.message ?? ''} ${e.extensions?.code ?? ''}`));
const LIMIT_CODE = 'query-limit';

/** Waits (in turn) until the budget has room and any cool-down is over. */
function slot(b: Budget, progress?: Progress): Promise<void> {
  const turn = b.queue.then(async () => {
    for (;;) {
      progress?.signal?.throwIfAborted();
      const now = Date.now();
      b.sent = b.sent.filter((t) => t > now - WINDOW_MS);
      const free = b.coolUntil > now ? b.coolUntil : b.sent.length >= BUDGET ? b.sent[0] + WINDOW_MS : 0;
      if (!free) { b.sent.push(now); if (progress) delete progress.note; return; }
      if (progress) progress.note = `Waiting for Cloudflare's analytics query limit (about 300 queries per 5 minutes) — continuing at ${utcTime(free)}`;
      await new Promise((resolve) => setTimeout(resolve, Math.min(free - now + 50, 30_000)));
    }
  });
  b.queue = turn.catch(() => undefined);
  return turn;
}

async function gql(token: string, text: string, progress?: Progress, tries = 2): Promise<Answer> {
  const b = budgetOf(token);
  await slot(b, progress);
  const stopped = progress?.signal;
  let a: Answer;
  try {
    const res = await fetch(GRAPHQL, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text }), signal: stopped ? AbortSignal.any([stopped, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000), cache: 'no-store',
    });
    const { body, errors } = await readAnswer<{ data?: { viewer?: { zones?: Record<string, unknown>[] } } | null }>(res);
    a = { status: res.status, data: body?.data?.viewer?.zones?.[0] ?? null, errors };
  } catch {
    // An abandoned read stops here (and in slot), instead of reading on for nobody.
    stopped?.throwIfAborted();
    return { status: 0, data: null, errors: [{ message: 'Could not reach the Cloudflare API' }] };
  }
  if (a.errors.length) console.warn(`[traffic] Cloudflare GraphQL answered ${a.status} with errors: ${JSON.stringify(a.errors).slice(0, 600)}`);
  if (isLimited(a)) {
    b.coolUntil = Math.max(b.coolUntil, Date.now() + COOL_MS);
    if (tries > 1) return gql(token, text, progress, tries - 1);
    return { status: a.status, data: null, errors: [{ message: `Cloudflare's analytics query limit was reached (${errorText(a.errors)}) — try again after ${utcTime(b.coolUntil)}`, extensions: { code: LIMIT_CODE } }] };
  }
  return a;
}

const zoneQuery = (zoneId: string, body: string) => `{ viewer { zones(filter: { zoneTag: ${J(zoneId)} }) { ${body} } } }`;

// ── What the zone's plan allows ─────────────────────────────────────────────

const DATASETS = ['firewallEventsAdaptiveGroups', 'firewallEventsAdaptive', 'httpRequestsAdaptiveGroups', 'httpRequestsAdaptive'] as const;
type Dataset = (typeof DATASETS)[number];

async function limitsOf(gq: Ask, zoneId: string): Promise<Record<Dataset, Limits>> {
  const ask = (fields: string) => gq(zoneQuery(zoneId, `settings { ${DATASETS.map((d) => `${d} { ${fields} }`).join(' ')} }`));
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

/** The month, or the chosen day / hour of it. */
function spanOf(month: string, f: DetailFilter | null, now = Date.now()) {
  if (f?.day) {
    const from = Date.parse(`${f.day}T00:00:00Z`) + (f.hour ?? 0) * 3_600_000;
    return { from, to: from + (f.hour !== undefined ? 3_600_000 : 86_400_000) };
  }
  const { since, until } = rangeOf(month, new Date(now));
  return { from: Date.parse(`${since}T00:00:00Z`), to: Date.parse(`${until}T00:00:00Z`) };
}

/** The part of the window this dataset still has, in parts of at most maxDuration. */
function windowOf(month: string, limits: Limits, f: DetailFilter | null, now = Date.now()) {
  const span = spanOf(month, f, now);
  const end = Math.min(span.to, now);
  const keptFrom = now - limits.notOlderThan * 1000 + 60_000;
  let start = Math.max(span.from, keptFrom);
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

const list = (xs: string[]) => `[${xs.map(J).join(', ')}]`;

const filterOf = (dataset: Dataset, f: DetailFilter | null) => {
  const ip = f?.ip ? `, clientIP: ${J(f.ip)}` : '';
  if (dataset === 'httpRequestsAdaptiveGroups' || dataset === 'httpRequestsAdaptive') {
    return ip + (f?.view === 'cache' ? `, cacheStatus_in: ${list(CACHED)}` : f?.view === 'origin' ? `, cacheStatus_notin: ${list(CACHED)}` : f?.view === 'pages' ? `, edgeResponseContentTypeName: ${J('html')}` : '');
  }
  return (ip || (f?.rule ? `, ruleId: ${J(f.rule)}` : f?.ruleset ? `, rulesetId: ${J(f.ruleset)}` : '')) + (f?.view === 'threats' ? `, action_in: ${list(THREAT_ACTIONS)}` : f?.view === 'unmitigated' ? `, action_notin: ${list(THREAT_ACTIONS)}` : '');
};
/** Top lists ranked by bandwidth (the Bandwidth card) or by count. */
const byBytes = (f: DetailFilter | null) => f?.view === 'bytes';
const rank = (f: DetailFilter | null) => (a: DetailRow, b: DetailRow) => (byBytes(f) ? (b.bytes ?? 0) - (a.bytes ?? 0) : 0) || b.count - a.count;

function groupsQuery(dataset: Dataset, zoneId: string, part: { since: string; until: string }, specs: Spec[], f: DetailFilter | null, pageSize: number) {
  return zoneQuery(zoneId, specs.map((s) =>
    `${s.alias}: ${dataset}(limit: ${Math.min(s.limit, pageSize)}, filter: { datetime_geq: ${J(part.since)}, datetime_lt: ${J(part.until)}${filterOf(dataset, f)} }, orderBy: [${byBytes(f) && s.bytes ? 'sum_edgeResponseBytes_DESC' : 'count_DESC'}]) `
    + `{ count ${s.bytes ? 'sum { edgeResponseBytes } ' : ''}dimensions { ${s.dims.join(' ')} } }`).join(' '));
}

interface Group { count?: number; sum?: { edgeResponseBytes?: number }; dimensions?: Record<string, unknown> }

/**
 * One query. A failing query is split until each failure is down to one breakdown, which is then
 * left out; breakdowns Cloudflare answers with an error next to others' data are read again on their
 * own. A spent query limit or a missing permission is not split (more queries would not help).
 */
async function readGroups(ask: Ask, dataset: Dataset, zoneId: string, part: { since: string; until: string }, specs: Spec[], f: DetailFilter | null,
  limits: Limits, failed: Map<string, string>): Promise<Record<string, Group[]>> {
  const live = specs.filter((s) => !failed.has(s.alias));
  if (!live.length) return {};
  const r = await ask(groupsQuery(dataset, zoneId, part, live, f, limits.maxPageSize));
  const missing = r.errors.length ? live.filter((s) => !Array.isArray(r.data?.[s.alias])) : [];
  const split = (x: Spec[]) => {
    const half = Math.ceil(x.length / 2);
    return Promise.all([x.slice(0, half), x.slice(half)].map((y) => readGroups(ask, dataset, zoneId, part, y, f, limits, failed))).then((p) => Object.assign({}, ...p) as Record<string, Group[]>);
  };
  const final = r.errors.some((e) => e.extensions?.code === LIMIT_CODE) || permissionError(r.errors, r.status);
  if (r.errors.length && (!r.data || missing.length === live.length)) {
    if (live.length > 1 && !final) return split(live);
    for (const s of live) failed.set(s.alias, errorText(r.errors));
    return {};
  }
  const got: Record<string, Group[]> = Object.fromEntries(live.filter((s) => !missing.includes(s)).map((s) => [s.alias, Array.isArray(r.data?.[s.alias]) ? (r.data![s.alias] as Group[]) : []]));
  if (missing.length === 1 || (missing.length && final)) for (const s of missing) failed.set(s.alias, errorText(r.errors));
  else if (missing.length) Object.assign(got, await split(missing));
  return got;
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

async function readDataset(ask: Ask, dataset: Dataset, zoneId: string, month: string, all: Spec[], f: DetailFilter | null, limits: Limits, progress: Progress): Promise<DatasetDetail> {
  const base: DatasetDetail = { available: false, notes: [], retentionDays: days(limits.notOlderThan), parts: 0, total: 0, breakdowns: {} };
  if (!limits.enabled) return { ...base, message: "Not available on this zone's plan" };
  const w = windowOf(month, limits, f);
  if (!w.parts.length) return { ...base, message: `Cloudflare keeps this for ${days(limits.notOlderThan)} days on this zone's plan — choose a more recent ${f?.day ? 'day' : 'month'}` };
  // The plan's field list is trusted only when it names some of these dimensions: some datasets list
  // just their top-level fields (count, dimensions, sum …), and that must not leave out every breakdown.
  // Without it, everything is tried, and what Cloudflare refuses is left out with its error.
  const named = all.some((s) => s.dims.some((d) => offered(limits, d))) ? limits : { ...limits, availableFields: null };
  const specs = all.filter((s) => s.dims.every((d) => offered(named, d)));
  const notOffered = all.filter((s) => !specs.includes(s)).map((s) => s.alias);
  if (!specs.length) return { ...base, message: "None of these breakdowns is offered on this zone's plan" };
  const queries = pack(specs, Math.max(3, limits.maxNumberOfFields));
  progress.total += w.parts.length * queries.length;

  const failed = new Map<string, string>();
  const merged = new Map<string, Map<string, DetailRow>>(specs.map((s) => [s.alias, new Map()]));
  const jobs = w.parts.flatMap((part) => queries.map((q) => ({ part, q })));
  const answers = await inParallel(jobs, PARALLEL, async (j) => {
    try { return await readGroups(ask, dataset, zoneId, j.part, j.q, f, limits, failed); } finally { progress.done++; }
  });
  for (const a of answers) for (const [alias, groups] of Object.entries(a)) addUp(merged.get(alias)!, groups);

  const ok = specs.filter((s) => !failed.has(s.alias));
  if (!ok.length) {
    const errs = [...failed.values()].map((m) => ({ message: m }));
    return { ...base, message: permissionError(errs, 0) ? `The token cannot read this — it needs "Zone › Analytics › Read" (${errorText(errs)})` : errorText(errs) };
  }
  const breakdowns = Object.fromEntries(ok.map((s) => {
    const t = TIME_DIM[s.alias];
    const rows = [...merged.get(s.alias)!.values()].sort((a, b) => (t ? a.dims[t].localeCompare(b.dims[t]) : rank(f)(a, b)));
    return [s.alias, t ? rows : rows.slice(0, SHOW[s.alias] ?? 25)];
  }));
  const notes: string[] = [];
  if (w.trimmed) notes.push(`Covers the last ${days((Date.parse(w.until!) - Date.parse(w.since!)) / 1000)} days of the month (read in at most ${MAX_PARTS} parts)`);
  if (notOffered.length) notes.push(`Not offered on this zone's plan: ${notOffered.join(', ')}`);
  for (const [alias, msg] of failed) notes.push(`${alias} could not be read: ${msg}`);
  const total = (timeRowsOf(breakdowns) ?? breakdowns.actions ?? breakdowns.statuses ?? []).reduce((n, r) => n + r.count, 0);
  return { available: true, notes, retentionDays: days(limits.notOlderThan), since: w.since, until: w.until, parts: w.parts.length, total, breakdowns };
}

/** The newest single records of a raw dataset (security events or requests) in the newest part of the window. */
async function readSingles(gq: Ask, dataset: 'firewallEventsAdaptive' | 'httpRequestsAdaptive', zoneId: string, month: string, f: DetailFilter | null, limits: Limits,
  fields: string[], minimal: string[], what: string): Promise<{ list: FirewallEvent[]; since?: string; note?: string }> {
  if (!limits.enabled) return { list: [], note: `Single ${what} are not available on this zone's plan` };
  const w = windowOf(month, limits, f);
  if (!w.parts.length) return { list: [] };
  // The newest full window (up to maxDuration) ending at the window's end, not just the newest part:
  // right after a part begins, that part holds only a few minutes.
  const until = w.until!;
  const last = { since: new Date(Math.max(Date.parse(w.since!), Date.parse(until) - limits.maxDuration * 1000)).toISOString(), until };
  const ask = (x: string[]) => gq(zoneQuery(zoneId,
    `rows: ${dataset}(limit: ${Math.min(listSize(f), limits.maxPageSize)}, filter: { datetime_geq: ${J(last.since)}, datetime_lt: ${J(last.until)}${filterOf(dataset, f)} }, orderBy: [datetime_DESC]) { ${x.join(' ')} }`));
  const named = fields.some((x) => offered(limits, x)) ? limits : { ...limits, availableFields: null };
  let r = await ask(fields.filter((x) => offered(named, x)));
  if (r.errors.length && !r.data && !r.errors.some((e) => e.extensions?.code === LIMIT_CODE)) r = await ask(minimal.filter((x) => offered(named, x)));
  if (r.errors.length && !r.data) return { list: [], note: `Single ${what} could not be read: ${errorText(r.errors)}` };
  return { list: Array.isArray(r.data?.rows) ? (r.data!.rows as FirewallEvent[]) : [], since: last.since };
}

// ── The zone detail ─────────────────────────────────────────────────────────

const IP = /^[0-9A-Fa-f:.]{2,45}$/;
const RULE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** At account level: the busiest zones of the month, at most this many. */
const ACCOUNT_ZONES = 5;
const ZONES_AT_ONCE = 2;
/** A read nobody has polled for this long is stopped: without a cache, nobody would ever see its result. (Browsers slow a hidden tab's timers to once a minute.) */
const ABANDON_MS = Number(process.env.TRAFFIC_DETAIL_ABANDON_MS) || 90_000;

const filterKey = (f: DetailFilter | null) =>
  `${f?.day ? `&day=${f.day}` : ''}${f?.hour !== undefined ? `&hour=${f.hour}` : ''}${f?.ip ? `&ip=${encodeURIComponent(f.ip)}` : ''}${f?.rule ? `&rule=${encodeURIComponent(f.rule)}` : ''}${f?.ruleset ? `&ruleset=${encodeURIComponent(f.ruleset)}` : ''}${f?.view ? `&view=${f.view}` : ''}${f?.part ? `&part=${f.part}` : ''}`;
const NO_RULE_REQUESTS = (): DatasetDetail => ({ available: false, message: 'Requests are not linked to rules', notes: [], retentionDays: null, parts: 0, total: 0, breakdowns: {} });
/** A section the window does not show is not read (it would only spend the query limit). */
const NOT_READ = (): DatasetDetail => ({ available: false, message: 'Not read for this view', notes: [], retentionDays: null, parts: 0, total: 0, breakdowns: {} });

// ── Managed rulesets deployed on the zone ───────────────────────────────────

interface ExecuteRule {
  description?: string; expression?: string; action?: string; enabled?: boolean;
  action_parameters?: { id?: string; overrides?: { action?: string; enabled?: boolean; categories?: { category?: string; enabled?: boolean; action?: string }[]; rules?: { id?: string; enabled?: boolean; action?: string; score_threshold?: number }[] } };
}

/** GET (read-only) the zone's managed-rules entrypoint: which managed rulesets run, where, and how they are tuned. */
async function readManaged(token: string, zoneId: string, names: Record<string, string>): Promise<{ list: ManagedDeployment[]; note?: string }> {
  let res: Response;
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/rulesets/phases/http_request_firewall_managed/entrypoint`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), cache: 'no-store' });
  } catch {
    return { list: [], note: 'Managed rules could not be read: the Cloudflare API was not reachable' };
  }
  if (res.status === 404) return { list: [] };
  const { body, errors } = await readAnswer<{ success?: boolean; result?: { rules?: ExecuteRule[] } }>(res);
  if (!res.ok || !body?.success) {
    return { list: [], note: `Managed rules could not be read${res.status === 403 ? ' — the token needs "Zone › Zone WAF › Read"' : ''} (${errorText(errors)})` };
  }
  const list = (body.result?.rules ?? []).filter((r) => r.action === 'execute' && r.action_parameters?.id).map((r): ManagedDeployment => {
    const id = r.action_parameters!.id!;
    const o = r.action_parameters!.overrides ?? {};
    const categories = (o.categories ?? []).filter((c) => c.category).map((c) => ({ category: c.category!, ...(c.enabled !== undefined ? { enabled: c.enabled } : {}), ...(c.action ? { action: c.action } : {}) }));
    const rules = (o.rules ?? []).filter((x) => x.id).map((x) => ({ id: x.id!, ...(x.enabled !== undefined ? { enabled: x.enabled } : {}), ...(x.action ? { action: x.action } : {}), ...(x.score_threshold !== undefined ? { scoreThreshold: x.score_threshold } : {}) }));
    const d: ManagedDeployment = {
      rulesetId: id, name: names[id] ?? MANAGED_RULESETS[id] ?? id, ...(r.description ? { description: r.description } : {}),
      enabled: r.enabled !== false, expression: r.expression ?? 'true', ...(o.action ? { action: o.action } : {}), categoryOverrides: categories, ruleOverrides: rules,
    };
    if (id === OWASP_RULESET) {
      // The highest paranoia level whose category is turned on (PL1 is always on).
      d.paranoiaLevel = [4, 3, 2].find((n) => categories.some((c) => c.category === `paranoia-level-${n}` && c.enabled === true)) ?? 1;
      const anomaly = rules.find((x) => x.id === OWASP_ANOMALY_RULE);
      if (anomaly?.scoreThreshold !== undefined) d.scoreThreshold = anomaly.scoreThreshold;
      d.anomalyAction = anomaly?.action ?? o.action ?? 'block';
    }
    return d;
  });
  return { list };
}

/** One zone's detail for the month, read from Cloudflare every time (never from the cache). */
async function readZoneDetail(scope: Scope, zoneId: string, month: string, f: DetailFilter | null, progress: Progress): Promise<ZoneDetail> {
  const zone = scope.zones.find((z) => z.id === zoneId)!;
  {
    const cred = scope.credentialOf[zoneId];
    let token = '';
    try { token = cred ? (await credentialForRun(cred.id, 'cloudflare')).fields.apiToken : ''; } catch { /* below */ }
    if (!token) throw new HttpError(409, 'The stored credential for this zone could not be decrypted');
    progress.total += 1;
    const ask: Ask = (text) => gql(token, text, progress);
    const limits = await limitsOf(ask, zoneId).finally(() => { progress.done++; });
    const noSecurity = f?.part === 'requests', noRequests = f?.part === 'security' || !!f?.rule || !!f?.ruleset;
    const [security, requests, events, names, samples] = await Promise.all([
      noSecurity ? Promise.resolve(NOT_READ()) : readDataset(ask, 'firewallEventsAdaptiveGroups', zoneId, month, [timeSpec(f, false), timeActionsSpec(f), ...SECURITY_SPECS.filter((s) => !(f?.ip && s.alias === 'ips') && !(f?.rule && s.alias === 'rules'))], f, limits.firewallEventsAdaptiveGroups, progress),
      f?.rule || f?.ruleset ? Promise.resolve(NO_RULE_REQUESTS()) : noRequests ? Promise.resolve(NOT_READ())
        : readDataset(ask, 'httpRequestsAdaptiveGroups', zoneId, month, [timeSpec(f, true), timeCacheSpec(f), ...REQUEST_SPECS.filter((s) => !(f?.ip && s.alias === 'ips'))], f, limits.httpRequestsAdaptiveGroups, progress),
      noSecurity ? Promise.resolve({ list: [] as FirewallEvent[] } as { list: FirewallEvent[]; since?: string; note?: string })
        : readSingles(ask, 'firewallEventsAdaptive', zoneId, month, f, limits.firewallEventsAdaptive, EVENT_FIELDS, EVENT_FIELDS_MIN, 'events'),
      rulesetNames(zoneId, true).then((n) => ({ ...MANAGED_RULESETS, ...n })).catch(() => ({ ...MANAGED_RULESETS })),
      noRequests ? Promise.resolve(null)
        : readSingles(ask, 'httpRequestsAdaptive', zoneId, month, f, limits.httpRequestsAdaptive, REQUEST_FIELDS, REQUEST_FIELDS_MIN, 'requests'),
    ]);
    if (events.note) security.notes.push(events.note);
    // The deployed managed rulesets belong to the zone, not to an IP or a rule: only read unnarrowed.
    const managed = f && (f.ip || f.rule || f.ruleset || f.day || noSecurity) ? null : await readManaged(token, zoneId, names);
    return {
      month, accountId: scope.accountId, accountName: scope.accountName, zoneId, zoneName: zone.name, filter: f,
      security: { ...security, events: events.list, ...(events.since ? { eventsSince: events.since } : {}) },
      requests: { ...requests, ...(samples ? { samples: samples.list, ...(samples.since ? { samplesSince: samples.since } : {}), ...(samples.note ? { samplesNote: samples.note } : {}) } : {}) },
      rulesetNames: names, generatedAt: new Date().toISOString(),
      ...(managed ? { managed: managed.list, ...(managed.note ? { managedNote: managed.note } : {}) } : {}),
    };
  }
}

/** The zones' datasets added up: breakdowns by their values, with a "zones" breakdown of each zone's total. */
function mergeDatasets(parts: { name: string; ds: DatasetDetail }[], f: DetailFilter | null): DatasetDetail {
  const ok = parts.filter((p) => p.ds.available);
  if (!ok.length) return { available: false, message: parts[0]?.ds.message ?? 'Not available', notes: [], retentionDays: null, parts: 0, total: 0, breakdowns: {} };
  const rows = new Map<string, Map<string, DetailRow>>();
  for (const { ds } of ok) {
    for (const [alias, list] of Object.entries(ds.breakdowns)) {
      const m = rows.get(alias) ?? new Map<string, DetailRow>();
      for (const r of list) {
        const key = JSON.stringify(r.dims);
        const cur = m.get(key) ?? { dims: r.dims, count: 0 };
        cur.count += r.count;
        if (r.bytes !== undefined) cur.bytes = (cur.bytes ?? 0) + r.bytes;
        m.set(key, cur);
      }
      rows.set(alias, m);
    }
  }
  const breakdowns: Record<string, DetailRow[]> = Object.fromEntries([...rows].map(([alias, m]) => {
    const t = TIME_DIM[alias];
    const list = [...m.values()].sort((a, b) => (t ? a.dims[t].localeCompare(b.dims[t]) : rank(f)(a, b)));
    return [alias, t ? list : list.slice(0, SHOW[alias] ?? 25)];
  }));
  breakdowns.zones = ok.map((p) => {
    const bytes = (timeRowsOf(p.ds.breakdowns) ?? []).reduce((n, r) => n + (r.bytes ?? 0), 0);
    return { dims: { zone: p.name }, count: p.ds.total, ...(bytes ? { bytes } : {}) };
  }).sort(rank(f));
  const since = ok.map((p) => p.ds.since).filter(Boolean).sort()[0];
  const until = ok.map((p) => p.ds.until).filter(Boolean).sort().at(-1);
  const kept = ok.map((p) => p.ds.retentionDays).filter((x): x is number => x !== null);
  const notes = [...new Set(ok.flatMap((p) => p.ds.notes.map((n) => `${p.name}: ${n}`)))];
  for (const p of parts.filter((x) => !x.ds.available)) notes.push(`${p.name}: ${p.ds.message ?? 'not available'}`);
  return {
    available: true, notes, retentionDays: kept.length ? Math.min(...kept) : null, ...(since ? { since } : {}), ...(until ? { until } : {}),
    parts: Math.max(...ok.map((p) => p.ds.parts)), total: ok.reduce((n, p) => n + p.ds.total, 0), breakdowns,
  };
}

/** An account: its busiest zones of the month read one by one, then added up. */
async function readAccountDetail(scope: Scope, month: string, f: DetailFilter | null, progress: Progress): Promise<ZoneDetail> {
  // The month's totals (usually cached already) say which zones had traffic, busiest first.
  const report = await trafficReport(month, scope.accountId, undefined, false, 90_000).catch(() => null);
  const totals = report && !('pending' in report) ? new Map(report.zones.map((z) => [z.id, z])) : null;
  const order = [...scope.zones].sort((a, b) => (totals?.get(b.id)?.totals.requests ?? 0) - (totals?.get(a.id)?.totals.requests ?? 0) || a.name.localeCompare(b.name));
  const zones: DetailZone[] = [];
  const pick: typeof scope.zones = [];
  for (const z of order) {
    const t = totals?.get(z.id);
    if (t && t.status === 'ok' && !t.totals.requests) zones.push({ id: z.id, name: z.name, status: 'no traffic' });
    else if (pick.length >= ACCOUNT_ZONES) zones.push({ id: z.id, name: z.name, status: 'left out', message: `Only the ${ACCOUNT_ZONES} busiest zones are added up — choose this zone to see it` });
    else pick.push(z);
  }
  const read = await inParallel(pick, ZONES_AT_ONCE, async (z) => {
    try { return { z, d: await readZoneDetail(scope, z.id, month, f, progress) }; } catch (e) { progress.signal?.throwIfAborted(); return { z, error: e instanceof Error ? e.message : String(e) }; }
  });
  const got = read.filter((x): x is { z: (typeof pick)[number]; d: ZoneDetail } => 'd' in x && !!x.d);
  for (const x of read) {
    const ok = 'd' in x && x.d && (x.d.security.available || x.d.requests.available);
    zones.push({ id: x.z.id, name: x.z.name, status: ok ? 'read' : 'unavailable', ...(!ok ? { message: 'error' in x ? x.error : (x.d?.security.message ?? 'Not available') } : {}) });
  }
  const events = got.flatMap((x) => x.d.security.events.map((e): FirewallEvent => ({ ...e, zone: x.z.name })))
    .sort((a, b) => String(b.datetime ?? '').localeCompare(String(a.datetime ?? ''))).slice(0, listSize(f));
  const samples = got.flatMap((x) => (x.d.requests.samples ?? []).map((e): FirewallEvent => ({ ...e, zone: x.z.name })))
    .sort((a, b) => String(b.datetime ?? '').localeCompare(String(a.datetime ?? ''))).slice(0, listSize(f));
  const samplesSince = got.map((x) => x.d.requests.samplesSince).filter(Boolean).sort()[0];
  const eventsSince = got.map((x) => x.d.security.eventsSince).filter(Boolean).sort()[0];
  const security = f?.part === 'requests' ? NOT_READ() : mergeDatasets(got.map((x) => ({ name: x.z.name, ds: x.d.security })), f);
  const requests = f?.rule || f?.ruleset ? NO_RULE_REQUESTS() : f?.part === 'security' ? NOT_READ()
    : { ...mergeDatasets(got.map((x) => ({ name: x.z.name, ds: x.d.requests })), f), samples, ...(samplesSince ? { samplesSince } : {}) };
  return {
    month, accountId: scope.accountId, accountName: scope.accountName, filter: f, zones: zones.sort((a, b) => a.name.localeCompare(b.name)),
    security: { ...security, events, ...(eventsSince ? { eventsSince } : {}) }, requests,
    rulesetNames: Object.assign({ ...MANAGED_RULESETS }, ...got.map((x) => x.d.rulesetNames)),
    ...(f && (f.ip || f.rule || f.ruleset || f.day || f.part === 'requests') ? {} : {
      managed: got.flatMap((x) => (x.d.managed ?? []).map((m) => ({ ...m, zone: x.z.name }))),
      ...(got.some((x) => x.d.managedNote) ? { managedNote: got.filter((x) => x.d.managedNote).map((x) => `${x.z.name}: ${x.d.managedNote}`).join(' · ') } : {}),
    }),
    generatedAt: got.map((x) => x.d.generatedAt).sort()[0] ?? new Date().toISOString(),
  };
}

/**
 * GET /api/traffic/detail?month=YYYY-MM&account=ID[&zone=ID][&ip=…|&rule=…]: one zone's security events and
 * requests for the month (as far back as its plan keeps them) — or, without a zone, the account's busiest
 * zones added up — or how far reading got.
 */
export async function zoneDetail(month: string, accountId: string, zoneId: string, filter: DetailFilter, job: string | null = null, waitMs = WAIT_MS): Promise<ZoneDetail | ZoneDetailPending> {
  if (!trafficMonths().includes(month)) throw new HttpError(400, 'Pick a month from the last 12 (YYYY-MM)');
  if (filter.ip && !IP.test(filter.ip)) throw new HttpError(400, 'Not an IP address');
  if (filter.rule && !RULE.test(filter.rule)) throw new HttpError(400, 'Not a rule ID');
  if (filter.ruleset && !RULE.test(filter.ruleset)) throw new HttpError(400, 'Not a ruleset ID');
  if ([filter.ip, filter.rule, filter.ruleset].filter(Boolean).length > 1) throw new HttpError(400, 'Narrow to one IP, rule or ruleset at a time');
  if (filter.day && (!/^\d{4}-\d{2}-\d{2}$/.test(filter.day) || !filter.day.startsWith(`${month}-`) || Number.isNaN(Date.parse(`${filter.day}T00:00:00Z`)))) throw new HttpError(400, 'Pick a day of the chosen month (YYYY-MM-DD)');
  if (filter.view && !DETAIL_VIEWS.includes(filter.view)) throw new HttpError(400, 'Unknown view');
  if (filter.part && filter.part !== 'security' && filter.part !== 'requests') throw new HttpError(400, 'Unknown part (security or requests)');
  if (filter.view && filter.part && SECURITY_VIEWS.includes(filter.view) !== (filter.part === 'security')) throw new HttpError(400, 'That view belongs to the other section');
  if (filter.hour !== undefined && (!filter.day || !Number.isInteger(filter.hour) || filter.hour < 0 || filter.hour > 23)) throw new HttpError(400, 'An hour (0–23) needs a day');
  const scope = await scopeOf(accountId, zoneId || undefined);
  const narrow: DetailFilter = filter.ip ? { ip: filter.ip } : filter.rule ? { rule: filter.rule } : filter.ruleset ? { ruleset: filter.ruleset } : {};
  const time: DetailFilter = filter.day ? { day: filter.day, ...(filter.hour !== undefined ? { hour: filter.hour } : {}) } : {};
  const shape: DetailFilter = { ...(filter.view ? { view: filter.view } : {}), ...(filter.part ? { part: filter.part } : {}) };
  const f: DetailFilter | null = Object.keys(narrow).length || Object.keys(time).length || Object.keys(shape).length ? { ...narrow, ...time, ...shape } : null;
  const key = `detail:month=${month}&account=${encodeURIComponent(accountId)}${zoneId ? `&zone=${encodeURIComponent(zoneId)}` : ''}${filterKey(f)}`;

  // Never from the cache: a request joins the read that is running for the same thing, or starts one;
  // a finished read is handed only to the polls of that read (they name its job), for a minute.
  const out = await inBackground<ZoneDetail>(key, (progress) => (zoneId ? readZoneDetail(scope, zoneId, month, f, progress) : readAccountDetail(scope, month, f, progress)),
    waitMs, { keepMs: 60_000, join: job, abandonMs: ABANDON_MS });
  return 'pending' in out ? { ...(out as Pending), month, accountId: scope.accountId, ...(zoneId ? { zoneId } : {}), filter: f } : out;
}
