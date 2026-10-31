import 'server-only';
import { cached } from './cache';
import { cfCall, cfGet, cfReason, ok } from './cf-read';
import { accountTargets } from './cf-targets';
import type { RawEntry } from './cf-audit';
import { HttpError } from './http';
import { zoneToken } from './zone-explorer';

// Two reads beside the main traffic page:
//  - DNS and Workers analytics from Cloudflare's GraphQL API (dnsAnalyticsAdaptiveGroups per zone,
//    workersInvocationsAdaptive per account), for the last 1, 7 or 30 days.
//  - Who READ the configuration: Audit Logs v2 also records views (action type "view"), which the
//    Cloudflare activity page leaves out. Grouped by person or token, so an unexpected reader stands out.

export const DAYS = [1, 7, 30] as const;
export type Days = (typeof DAYS)[number];
export const isDays = (n: number): n is Days => (DAYS as readonly number[]).includes(n);

const TTL = 10 * 60_000;
const period = (days: Days) => {
  const until = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  return { since: new Date(until.getTime() - days * 86_400_000).toISOString(), until: until.toISOString() };
};

async function graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await cfCall<T>(token, 'POST', '/graphql', { query, variables });
  const body = r.body as unknown as { data?: T; errors?: { message?: string }[] } | null;
  if (r.status !== 200 || !body) throw new HttpError(r.status === 403 ? 403 : 502, `Cloudflare: ${cfReason(r)}`);
  if (body.errors?.length) throw new HttpError(502, `Cloudflare: ${body.errors.map((e) => e.message).join('; ')}`);
  return body.data as T;
}

export interface Bar { label: string; value: number; extra?: number }
export interface Top { name: string; value: number; extra?: number; extra2?: number }

export interface DnsReport { zoneId: string; zoneName: string; days: Days; since: string; until: string; total: number; series: Bar[]; names: Top[]; types: Top[]; codes: Top[]; generatedAt: string }

/** DNS queries Cloudflare answered for a zone: over time, and the top names, types and response codes. */
export function dnsReport(zoneId: string, days: Days, fresh = false): Promise<DnsReport> {
  return cached(`path:/api/analytics/dns/${zoneId}/${days}`, TTL, async () => {
    const { token, zone } = await zoneToken(zoneId);
    const w = period(days);
    const time = days === 1 ? 'datetimeHour' : 'date';
    type G = { count: number; dimensions: Record<string, string> };
    const data = await graphql<{ viewer: { zones: { series: G[]; names: G[]; types: G[]; codes: G[] }[] } }>(token, `query ($zone: String!, $since: Time!, $until: Time!) {
  viewer { zones(filter: { zoneTag: $zone }) {
    series: dnsAnalyticsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [${time}_ASC]) { count dimensions { ${time} } }
    names: dnsAnalyticsAdaptiveGroups(limit: 15, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [count_DESC]) { count dimensions { queryName } }
    types: dnsAnalyticsAdaptiveGroups(limit: 15, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [count_DESC]) { count dimensions { queryType } }
    codes: dnsAnalyticsAdaptiveGroups(limit: 15, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [count_DESC]) { count dimensions { responseCode } }
  } }
}`, { zone: zoneId, ...w });
    const z = data.viewer.zones[0] ?? { series: [], names: [], types: [], codes: [] };
    const top = (rows: G[], key: string): Top[] => rows.map((r) => ({ name: r.dimensions[key] || '(none)', value: r.count }));
    const series = z.series.map((r) => ({ label: r.dimensions[time], value: r.count }));
    return { zoneId, zoneName: zone.name, days, since: w.since, until: w.until, total: series.reduce((s, b) => s + b.value, 0), series, names: top(z.names, 'queryName'), types: top(z.types, 'queryType'), codes: top(z.codes, 'responseCode'), generatedAt: new Date().toISOString() };
  }, fresh);
}

export interface WorkersReport { accountId: string; accountName: string; days: Days; since: string; until: string; requests: number; errors: number; series: Bar[]; scripts: Top[]; generatedAt: string }

/** Worker requests and errors in an account: over time, and per Worker with CPU time (p50 / p99, ms). */
export function workersReport(accountId: string, days: Days, fresh = false): Promise<WorkersReport> {
  return cached(`path:/api/analytics/workers/${accountId}/${days}`, TTL, async () => {
    const t = (await accountTargets()).accounts.find((x) => x.accountId === accountId);
    if (!t) throw new HttpError(404, 'No stored credential reads that account');
    const w = period(days);
    const time = days === 1 ? 'datetimeHour' : 'date';
    type G = { sum: { requests: number; errors: number }; quantiles?: { cpuTimeP50?: number; cpuTimeP99?: number }; dimensions: Record<string, string> };
    const data = await graphql<{ viewer: { accounts: { series: G[]; scripts: G[] }[] } }>(t.token, `query ($account: String!, $since: Time!, $until: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    series: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [${time}_ASC]) { sum { requests errors } dimensions { ${time} } }
    scripts: workersInvocationsAdaptive(limit: 50, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [sum_requests_DESC]) { sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { scriptName } }
  } }
}`, { account: accountId, ...w });
    const a = data.viewer.accounts[0] ?? { series: [], scripts: [] };
    // Several rows can share an hour or a day (one per status): add them up.
    const byTime = new Map<string, Bar>();
    for (const r of a.series) {
      const k = r.dimensions[time];
      const b = byTime.get(k) ?? { label: k, value: 0, extra: 0 };
      b.value += r.sum.requests; b.extra! += r.sum.errors;
      byTime.set(k, b);
    }
    const series = [...byTime.values()].sort((x, y) => x.label.localeCompare(y.label));
    // CPU time comes in microseconds.
    const scripts = a.scripts.map((r) => ({ name: r.dimensions.scriptName, value: r.sum.requests, extra: r.sum.errors, extra2: r.quantiles?.cpuTimeP99 !== undefined ? Math.round(r.quantiles.cpuTimeP99 / 100) / 10 : undefined }));
    return { accountId, accountName: t.accountName, days, since: w.since, until: w.until, requests: series.reduce((s, b) => s + b.value, 0), errors: series.reduce((s, b) => s + (b.extra ?? 0), 0), series, scripts, generatedAt: new Date().toISOString() };
  }, fresh);
}

// ── Who read the configuration ──────────────────────────────────────────────

export interface Reader { actor: string; kind: 'user' | 'token' | 'other'; count: number; lastSeen: string; ips: string[]; products: string[] }
export interface ReadsReport { accountId: string; days: Days; since: string; until: string; total: number; truncated: boolean; readers: Reader[]; generatedAt: string }

const MAX_VIEWS = 10_000;

export function readsReport(accountId: string, days: Days, fresh = false): Promise<ReadsReport> {
  return cached(`path:/api/cloudflare-audit/reads/${accountId}/${days}`, TTL, async () => {
    const t = (await accountTargets()).accounts.find((x) => x.accountId === accountId);
    if (!t) throw new HttpError(404, 'No stored credential reads that account');
    const w = period(days);
    const by = new Map<string, Reader & { productCount: Map<string, number>; ipSet: Set<string> }>();
    let total = 0, cursor = '', truncated = false;
    for (;;) {
      const q = new URLSearchParams({ since: w.since, before: w.until, limit: '1000', direction: 'desc', action_type: 'view' });
      if (cursor) q.set('cursor', cursor);
      const r = await cfGet<RawEntry[]>(t.token, `/accounts/${accountId}/logs/audit?${q}`);
      if (!ok(r)) throw new HttpError(r.status === 403 ? 403 : 502, r.status === 403 ? `The token cannot read the audit log — it needs “Account Settings Read” (${cfReason(r)})` : `Cloudflare: ${cfReason(r)}`);
      const rows = (r.body!.result ?? []).filter((e) => (e.action?.type ?? '').toLowerCase() === 'view');
      for (const e of rows) {
        const kind: Reader['kind'] = e.actor?.email ? 'user' : e.actor?.token_name ? 'token' : 'other';
        const actor = e.actor?.email || (e.actor?.token_name ? `token “${e.actor.token_name}”` : e.actor?.type || 'unknown');
        const cur = by.get(actor) ?? { actor, kind, count: 0, lastSeen: '', ips: [], products: [], productCount: new Map(), ipSet: new Set() };
        cur.count++;
        const time = e.action?.time ?? '';
        if (time > cur.lastSeen) cur.lastSeen = time;
        if (e.actor?.ip_address) cur.ipSet.add(e.actor.ip_address);
        const product = e.resource?.product ?? '';
        if (product) cur.productCount.set(product, (cur.productCount.get(product) ?? 0) + 1);
        by.set(actor, cur);
      }
      total += rows.length;
      cursor = r.body!.result_info?.cursor ?? '';
      if (!cursor || !rows.length) break;
      if (total >= MAX_VIEWS) { truncated = true; break; }
    }
    const readers = [...by.values()].map(({ productCount, ipSet, ...x }) => ({
      ...x, ips: [...ipSet].slice(0, 5), products: [...productCount].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p]) => p),
    })).sort((a, b) => b.count - a.count);
    return { accountId, days, since: w.since, until: w.until, total, truncated, readers, generatedAt: new Date().toISOString() };
  }, fresh);
}
