import 'server-only';
import { ReadError, cfGet, cfList, cfReason, inParallel, mask, ok, refused, type CfAnswer } from '../cf-read';
import { Lookups, dohEnabled } from '../doh';
import { inZone, takeoverService } from '../dns-hygiene';
import { J, errorText, gql, isLimit, isPermission, offered, zoneLimits, type Limits } from '../investigate-gql';
import { buildReport } from './report';
import {
  AUDIT_PHASES, AUDIT_SETTINGS,
  type AuditReport, type CnameLookups, type DnsRec, type EventData, type Got, type RequestData, type Snapshot, type SourceKey, type ZoneInfo,
} from './types';

// Reads one zone for the security audit: about 50 Cloudflare API GETs through cf-read (the per-token
// budget and 429 pause), at most CNAME_LOOKUPS public DNS answers (doh.ts), and the traffic window
// with GraphQL queries through investigate-gql (the shared analytics budget; queries only, sent as
// POST because that is how GraphQL takes them). Nothing is written to Cloudflare. A read that fails
// is kept as an error with Cloudflare's reason, so the rules that need it say "not read".

const PARALLEL = 6;
/** Public DNS lookups per audit (takeover-prone CNAME targets first). */
export const CNAME_LOOKUPS = 40;
/** IP Access rules read per scope at most. */
export const ACCESS_MAX = 2_000;
/** Parts of the traffic window per dataset (each part is one plan maxDuration, usually 1–3 days). */
export const MAX_PARTS = 12;

/** Cloudflare's words for a product the plan does not include (as opposed to a token without the permission). */
const NOT_ENTITLED = /not entitled|entitlement|subscri|upgrade|your plan|plan does not|not available (?:on|for) (?:this|your) plan|not enabled for (?:this|the) zone/i;

/** One answer as a read: ok, absent (404 or the plan lacks it), or error. Values pass through mask() (secret-looking fields). */
export function classify(r: CfAnswer, empty404?: unknown): Got<unknown> {
  if (ok(r)) return { state: 'ok', value: mask(r.body!.result) };
  if (r.status === 404 && empty404 !== undefined) return { state: 'ok', value: empty404 };
  const reason = cfReason(r);
  if (r.status === 404 || (refused(r) && NOT_ENTITLED.test(reason))) return { state: 'absent', reason: `Cloudflare says it is not available on this zone (${reason})` };
  return { state: 'error', status: r.status, reason: refused(r) ? `The token cannot read this (${reason})` : reason };
}
const fromError = (err: unknown): Got<unknown> => {
  if (err instanceof ReadError) {
    if (err.status === 404 || ((err.status === 401 || err.status === 403) && NOT_ENTITLED.test(err.message))) return { state: 'absent', reason: `Cloudflare says it is not available on this zone (${err.message})` };
    return { state: 'error', status: err.status, reason: err.message };
  }
  return { state: 'error', status: 0, reason: err instanceof Error ? err.message : String(err) };
};

export interface AuditRead { snapshot: Snapshot; calls: number; lookups: number }

/** Reads everything the rules need. `hours`: the traffic window asked for. */
export async function readZone(token: string, zoneId: string, zoneName: string, hours: number, signal?: AbortSignal, accountId?: string): Promise<AuditRead> {
  let calls = 0;
  const get = (path: string) => { calls++; return cfGet(token, path, signal); };
  const reads: Snapshot['reads'] = {};
  const base = `/zones/${encodeURIComponent(zoneId)}`;

  const single: [SourceKey, string, unknown?][] = [
    ['zone', base],
    ...AUDIT_SETTINGS.map((id): [SourceKey, string] => [`setting:${id}`, `${base}/settings/${id}`]),
    ...AUDIT_PHASES.map((p): [SourceKey, string, unknown] => [`phase:${p}`, `${base}/rulesets/phases/${p}/entrypoint`, { rules: [] }]),
    ['dnssec', `${base}/dnssec`],
    ['aop', `${base}/origin_tls_client_auth/settings`],
    ['bot', `${base}/bot_management`],
    ['page_shield', `${base}/page_shield`],
    ['worker_routes', `${base}/workers/routes`],
    ['managed_headers', `${base}/managed_headers`],
    ['universal_ssl', `${base}/ssl/universal/settings`],
    ['leaked_credentials', `${base}/leaked-credential-checks`],
    ['schema_validation', `${base}/schema_validation/settings`],
  ];
  await inParallel(single, PARALLEL, async ([key, path, empty]) => {
    try { reads[key] = classify(await get(path), empty); } catch (err) { signal?.throwIfAborted(); reads[key] = fromError(err); }
  });
  // An entrypoint read gives the ruleset; the rules want its rules.
  for (const p of AUDIT_PHASES) { const g = reads[`phase:${p}`]; if (g?.state === 'ok') reads[`phase:${p}`] = { state: 'ok', value: (g.value as { rules?: unknown[] })?.rules ?? [] }; }
  const z = reads.zone;
  if (z?.state === 'ok') {
    const v = z.value as { id?: string; name?: string; status?: string; type?: string; plan?: { legacy_id?: string; name?: string } };
    reads.zone = { state: 'ok', value: { id: zoneId, name: v.name ?? zoneName, status: v.status ?? '', type: v.type ?? 'full', plan: (v.plan?.legacy_id ?? v.plan?.name ?? '').toLowerCase() } satisfies ZoneInfo };
  }

  // API Shield endpoints: only the count (the smallest page Cloudflare allows, 5, and total_count read).
  try {
    const r = await get(`${base}/api_gateway/operations?per_page=5`);
    const g = classify(r);
    reads.api_operations = g.state === 'ok' ? { state: 'ok', value: { total: Number(r.body?.result_info?.total_count ?? (Array.isArray(g.value) ? g.value.length : 0)) } } : g;
  } catch (err) { signal?.throwIfAborted(); reads.api_operations = fromError(err); }

  const lists: [SourceKey, string, { perPage: number; max: number }][] = [
    ['dns', `${base}/dns_records`, { perPage: 5_000, max: 50_000 }],
    ['certificates', `${base}/ssl/certificate_packs?status=all`, { perPage: 50, max: 500 }],
    ['page_rules', `${base}/pagerules`, { perPage: 0, max: 500 }],
    // IP Access rules and legacy rules: capped (a zone with thousands is reported as "many", not read in full).
    ['access_rules', `${base}/firewall/access_rules/rules`, { perPage: 1_000, max: ACCESS_MAX }],
    ['lockdowns', `${base}/firewall/lockdowns`, { perPage: 100, max: 500 }],
    ['ua_rules', `${base}/firewall/ua_rules`, { perPage: 100, max: 500 }],
    ...(accountId ? [['account_access_rules', `/accounts/${encodeURIComponent(accountId)}/firewall/access_rules/rules`, { perPage: 1_000, max: ACCESS_MAX }] as [SourceKey, string, { perPage: number; max: number }]] : []),
  ];
  if (!accountId) reads.account_access_rules = { state: 'error', status: 0, reason: 'The zone\'s account is not known' };
  await inParallel(lists, 4, async ([key, path, o]) => {
    try {
      // cfList counts its own pages; one call per page is close enough for the total (pages are rare here).
      calls++;
      reads[key] = { state: 'ok', value: mask(await cfList(token, path, { ...o, signal })) };
    } catch (err) { signal?.throwIfAborted(); reads[key] = fromError(err); }
  });

  // Public DNS answers for CNAME targets outside the zone (takeover-prone first), at most CNAME_LOOKUPS.
  let lookups = 0;
  if (reads.dns?.state !== 'ok') reads.cname_lookups = { state: 'error', status: 0, reason: 'The DNS records were not read' };
  else if (!dohEnabled()) reads.cname_lookups = { state: 'error', status: 0, reason: 'Public DNS lookups are turned off (DNS_HEALTH_DOH=off)' };
  else {
    const look = new Lookups(CNAME_LOOKUPS);
    const targets = [...new Set((reads.dns.value as DnsRec[]).filter((r) => r.type === 'CNAME' && r.content && !inZone(r.content, zoneName)).map((r) => r.content.toLowerCase().replace(/\.$/, '')))]
      .sort((a, b) => Number(!takeoverService(a)) - Number(!takeoverService(b)) || a.localeCompare(b));
    const answers: Record<string, number> = {};
    let skipped = 0;
    for (const t of targets) {
      signal?.throwIfAborted();
      const a = await look.resolve(t, 'A');
      if (!a || a.status === -1) { skipped++; continue; }
      answers[t] = a.status;
    }
    lookups = look.used;
    reads.cname_lookups = { state: 'ok', value: { answers, skipped } satisfies CnameLookups };
  }

  const t = await readTraffic(token, zoneId, hours, signal);
  Object.assign(reads, t.reads);
  return { snapshot: { zoneId, zoneName, now: new Date().toISOString(), reads, hours: t.hours, askedHours: hours }, calls: calls + t.queries, lookups };
}

// ── Traffic (GraphQL) ───────────────────────────────────────────────────────

interface Spec { alias: string; dims: string[]; limit: number }
const EVENT_SPECS: Spec[] = [
  { alias: 'rules', dims: ['ruleId', 'rulesetId', 'source', 'action', 'description'], limit: 1000 },
  { alias: 'paths', dims: ['ruleId', 'source', 'action', 'clientRequestHTTPHost', 'clientRequestPath'], limit: 2000 },
  { alias: 'countries', dims: ['ruleId', 'source', 'action', 'clientCountryName'], limit: 2000 },
  { alias: 'asns', dims: ['ruleId', 'source', 'action', 'clientAsn', 'clientASNDescription'], limit: 2000 },
  { alias: 'ips', dims: ['ruleId', 'source', 'action', 'clientIP'], limit: 5000 },
  { alias: 'uas', dims: ['ruleId', 'source', 'action', 'userAgent'], limit: 2000 },
];
/**
 * Optional dimensions, each in its own query and only when the plan's field list offers the field:
 * response status, hour (rate peaks), Bot Management bot score (Enterprise) and WAF attack score
 * (Enterprise). When the plan publishes no field list, each is tried once on the newest part; a
 * refusal there leaves it out for the rest of the window.
 */
const OPTIONAL_SPECS: (Spec & { field: string })[] = [
  { alias: 'statuses', field: 'edgeResponseStatus', dims: ['ruleId', 'source', 'action', 'edgeResponseStatus'], limit: 3000 },
  { alias: 'hours', field: 'datetimeHour', dims: ['ruleId', 'source', 'action', 'datetimeHour'], limit: 5000 },
  { alias: 'bots', field: 'botScore', dims: ['ruleId', 'source', 'action', 'botScore', 'verifiedBotCategory'], limit: 5000 },
  { alias: 'attacks', field: 'wafAttackScore', dims: ['ruleId', 'source', 'action', 'wafAttackScore'], limit: 5000 },
];
const REQUEST_SPECS: Spec[][] = [
  [{ alias: 'paths', dims: ['clientRequestHTTPHost', 'clientRequestPath', 'edgeResponseStatus'], limit: 5000 }],
  [{ alias: 'asns', dims: ['clientAsn', 'clientASNDescription', 'edgeResponseStatus'], limit: 2000 }],
];

/** Queries of at most `max` fields each (each dimension and the count is one). */
function pack(specs: Spec[], max: number): Spec[][] {
  const out: Spec[][] = [];
  let cur: Spec[] = [], n = 0;
  for (const s of specs) {
    const w = s.dims.length + 1;
    if (cur.length && n + w > max) { out.push(cur); cur = []; n = 0; }
    cur.push(s); n += w;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** [start, end) cut into parts of the plan's maxDuration, at most MAX_PARTS, never older than the plan keeps. */
export function windowParts(end: number, hours: number, l: Limits) {
  const oldest = end - l.notOlderThan * 1000 + 60_000;
  const step = l.maxDuration * 1000;
  const start = Math.max(end - hours * 3600_000, oldest, end - step * MAX_PARTS);
  const parts: { since: string; until: string }[] = [];
  for (let t = start; t < end; t += step) parts.push({ since: new Date(t).toISOString(), until: new Date(Math.min(t + step, end)).toISOString() });
  return { parts, start, hours: Math.round((end - start) / 3600_000) };
}

type G = { count?: number; dimensions?: Record<string, unknown> };
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** Reads `specs` over the parts; rows of each alias merged by their dimensions. Throws a Got error on refusal or limit. */
async function grouped(token: string, zoneId: string, dataset: string, specs: Spec[][], parts: { since: string; until: string }[], l: Limits, count: () => void, signal?: AbortSignal) {
  const merged = new Map<string, Map<string, { dims: Record<string, string>; count: number }>>(specs.flat().map((s) => [s.alias, new Map()]));
  const problems: string[] = [];
  for (const part of parts) {
    for (const q of specs) {
      signal?.throwIfAborted();
      const text = `{ viewer { zones(filter: { zoneTag: ${J(zoneId)} }) { ${q.map((s) => `${s.alias}: ${dataset}(limit: ${Math.min(s.limit, l.maxPageSize)}, `
        + `filter: { datetime_geq: ${J(part.since)}, datetime_lt: ${J(part.until)} }, orderBy: [count_DESC]) { count dimensions { ${s.dims.join(' ')} } }`).join(' ')} } } }`;
      count();
      const r = await gql<{ viewer?: { zones?: Record<string, G[]>[] } }>(token, text, {}, signal ? { done: 0, total: 0, signal } : undefined);
      if (r.errors.length) {
        if (isPermission(r.errors, r.status)) throw { state: 'error', status: 403, reason: `The token cannot read this zone's analytics (${errorText(r.errors)})` } satisfies Got<never>;
        if (isLimit(r.errors)) throw { state: 'error', status: 429, reason: errorText(r.errors) } satisfies Got<never>;
        // A part with no data would read as "no events" (and a rule as "never matched"): the whole read fails instead.
        if (!r.data?.viewer?.zones?.[0]) throw { state: 'error', status: r.status, reason: `The ${part.since.slice(0, 10)} part of the window could not be read (${errorText(r.errors)})` } satisfies Got<never>;
        problems.push(`${part.since.slice(0, 10)}: ${errorText(r.errors)}`);
      }
      const got = r.data?.viewer?.zones?.[0] ?? {};
      for (const s of q) for (const g of got[s.alias] ?? []) {
        const dims = Object.fromEntries(Object.entries(g.dimensions ?? {}).map(([k, v]) => [k, str(v)]));
        const key = JSON.stringify(dims);
        const m = merged.get(s.alias)!;
        const row = m.get(key) ?? { dims, count: 0 };
        row.count += g.count ?? 0;
        m.set(key, row);
      }
    }
  }
  return { rows: (alias: string) => [...(merged.get(alias)?.values() ?? [])], problems };
}

async function readTraffic(token: string, zoneId: string, hours: number, signal?: AbortSignal): Promise<{ reads: Snapshot['reads']; hours: number; queries: number }> {
  let queries = 0;
  const count = () => { queries++; };
  const reads: Snapshot['reads'] = {};
  const fail = (g: Got<never>) => { reads.events = g; reads.events_previous = g; reads.requests = g; };
  let limits: Awaited<ReturnType<typeof zoneLimits>>;
  try { queries++; limits = await zoneLimits(token, zoneId); } catch (err) { fail({ state: 'error', status: 0, reason: err instanceof Error ? err.message : String(err) }); return { reads, hours, queries }; }
  const end = Date.now();
  const fw = limits.firewallEventsAdaptiveGroups;
  let used = hours;
  if (!fw.enabled) { reads.events = reads.events_previous = { state: 'absent', reason: 'Security events (firewallEventsAdaptiveGroups) are not offered on this zone\'s plan' }; }
  else {
    const w = windowParts(end, hours, fw);
    used = w.hours;
    const notes = used < hours ? [`The window is ${used} hours, not ${hours}: the plan keeps security events for ${Math.round(fw.notOlderThan / 3600)} hours and one audit reads at most ${MAX_PARTS} parts of ${Math.round(fw.maxDuration / 3600)} hours.`] : [];
    try {
      const g = await grouped(token, zoneId, 'firewallEventsAdaptiveGroups', pack(EVENT_SPECS, Math.max(6, fw.maxNumberOfFields)), w.parts, fw, count, signal);
      const R = g.rows;
      const opt: Record<string, { dims: Record<string, string>; count: number }[] | null> = {};
      for (const o of OPTIONAL_SPECS) {
        if (fw.availableFields && !offered(fw, o.field)) { opt[o.alias] = null; continue; }
        const parts = [...w.parts].reverse();
        try {
          const first = await grouped(token, zoneId, 'firewallEventsAdaptiveGroups', [[o]], parts.slice(0, 1), fw, count, signal);
          const rest = parts.length > 1 ? await grouped(token, zoneId, 'firewallEventsAdaptiveGroups', [[o]], parts.slice(1), fw, count, signal) : null;
          opt[o.alias] = [...first.rows(o.alias), ...(rest?.rows(o.alias) ?? [])];
        } catch (err) {
          signal?.throwIfAborted();
          if (isGot(err) && err.state === 'error' && err.status === 429) throw err;
          opt[o.alias] = null;
        }
      }
      reads.events = { state: 'ok', value: {
        since: new Date(w.start).toISOString(), until: new Date(end).toISOString(), notes: [...notes, ...g.problems.slice(0, 3).map((p) => `Part not read: ${p}`)],
        rules: R('rules').map((r) => ({ ruleId: r.dims.ruleId, rulesetId: r.dims.rulesetId, source: r.dims.source, action: r.dims.action, description: r.dims.description, count: r.count })),
        paths: R('paths').map((r) => ({ ruleId: r.dims.ruleId, source: r.dims.source, action: r.dims.action, host: r.dims.clientRequestHTTPHost, path: r.dims.clientRequestPath, count: r.count })),
        countries: R('countries').map((r) => ({ ruleId: r.dims.ruleId, source: r.dims.source, action: r.dims.action, country: r.dims.clientCountryName, count: r.count })),
        asns: R('asns').map((r) => ({ ruleId: r.dims.ruleId, source: r.dims.source, action: r.dims.action, asn: r.dims.clientAsn, name: r.dims.clientASNDescription, count: r.count })),
        ips: R('ips').map((r) => ({ ruleId: r.dims.ruleId, source: r.dims.source, action: r.dims.action, ip: r.dims.clientIP, count: r.count })),
        uas: R('uas').map((r) => ({ ruleId: r.dims.ruleId, source: r.dims.source, action: r.dims.action, ua: r.dims.userAgent, count: r.count })),
        statuses: opt.statuses?.map((r) => ({ ruleId: r.dims.ruleId, source: r.dims.source, action: r.dims.action, status: Number(r.dims.edgeResponseStatus) || 0, count: r.count })) ?? null,
        hours: opt.hours?.map((r) => ({ ruleId: r.dims.ruleId, source: r.dims.source, action: r.dims.action, hour: r.dims.datetimeHour, count: r.count })) ?? null,
        bots: opt.bots?.map((r) => ({ ruleId: r.dims.ruleId, source: r.dims.source, action: r.dims.action, score: Number(r.dims.botScore) || 0, verified: r.dims.verifiedBotCategory ?? '', count: r.count })) ?? null,
        attacks: opt.attacks?.map((r) => ({ ruleId: r.dims.ruleId, source: r.dims.source, action: r.dims.action, score: Number(r.dims.wafAttackScore) || 0, count: r.count })) ?? null,
      } satisfies EventData };
    } catch (err) { signal?.throwIfAborted(); reads.events = isGot(err) ? err : { state: 'error', status: 0, reason: String(err) }; }
    // The window before, for the trend: only the per-rule counts, and only when the plan still keeps it.
    const prevEnd = w.start;
    if (reads.events.state !== 'ok') reads.events_previous = reads.events;
    else if (prevEnd - used * 3600_000 < end - fw.notOlderThan * 1000 + 60_000) reads.events_previous = { state: 'absent', reason: 'The window before is older than the plan keeps security events' };
    else {
      try {
        const g = await grouped(token, zoneId, 'firewallEventsAdaptiveGroups', [[EVENT_SPECS[0]]], windowParts(prevEnd, used, fw).parts, fw, count, signal);
        reads.events_previous = { state: 'ok', value: { since: new Date(prevEnd - used * 3600_000).toISOString(), until: new Date(prevEnd).toISOString(), notes: [], paths: [], countries: [], asns: [], ips: [], uas: [], statuses: null, hours: null, bots: null, attacks: null,
          rules: g.rows('rules').map((r) => ({ ruleId: r.dims.ruleId, rulesetId: r.dims.rulesetId, source: r.dims.source, action: r.dims.action, description: r.dims.description, count: r.count })) } satisfies EventData };
      } catch (err) { signal?.throwIfAborted(); reads.events_previous = isGot(err) ? err : { state: 'error', status: 0, reason: String(err) }; }
    }
  }
  const rq = limits.httpRequestsAdaptiveGroups;
  if (!rq.enabled) reads.requests = { state: 'absent', reason: 'HTTP request analytics (httpRequestsAdaptiveGroups) are not offered on this zone\'s plan' };
  else {
    const w = windowParts(end, used, rq);
    try {
      const g = await grouped(token, zoneId, 'httpRequestsAdaptiveGroups', REQUEST_SPECS, w.parts, rq, count, signal);
      reads.requests = { state: 'ok', value: {
        since: new Date(w.start).toISOString(), until: new Date(end).toISOString(),
        notes: [...(w.hours < used ? [`Requests were read for ${w.hours} hours only (the plan keeps less than the window).`] : []), ...g.problems.slice(0, 3).map((p) => `Part not read: ${p}`)],
        paths: g.rows('paths').map((r) => ({ host: r.dims.clientRequestHTTPHost, path: r.dims.clientRequestPath, status: Number(r.dims.edgeResponseStatus) || 0, count: r.count })),
        asns: g.rows('asns').map((r) => ({ asn: r.dims.clientAsn, name: r.dims.clientASNDescription, status: Number(r.dims.edgeResponseStatus) || 0, count: r.count })),
      } satisfies RequestData };
    } catch (err) { signal?.throwIfAborted(); reads.requests = isGot(err) ? err : { state: 'error', status: 0, reason: String(err) }; }
  }
  return { reads, hours: used, queries };
}
const isGot = (x: unknown): x is Got<never> => !!x && typeof x === 'object' && 'state' in x;

/** Reads the zone and builds its report. */
export async function auditZone(o: { token: string; zoneId: string; zoneName: string; accountId: string; accountName: string; hours: number; signal?: AbortSignal }): Promise<AuditReport> {
  const startedAt = new Date().toISOString();
  const r = await readZone(o.token, o.zoneId, o.zoneName, o.hours, o.signal, o.accountId || undefined);
  return buildReport(r.snapshot, { accountId: o.accountId, accountName: o.accountName, startedAt, finishedAt: new Date().toISOString(), calls: r.calls, lookups: r.lookups });
}
