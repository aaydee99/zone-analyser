import 'server-only';
import { compactNum } from './num';
import { asMonitor, cfCall, cfReason, inParallel } from './cf-read';
import { accountTargets } from './cf-targets';
import { zoneToken } from './zone-explorer';
import { MAX_TRAFFIC_ACCOUNTS, MAX_TRAFFIC_ZONES, type SecurityNumbers, type TrafficNumbers, type TrafficSection } from './report-types';

// The traffic & security section of a scheduled report: this period against the one before, read
// from Cloudflare's GraphQL Analytics API when the report is made. Cost is bounded:
//  - all / accounts reports: account-level totals, two queries per account (traffic, security
//    events), never one per zone — httpRequestsOverviewAdaptiveGroups and firewallEventsAdaptiveGroups
//    on viewer.accounts;
//  - tag reports: the same datasets per zone, 10 zones per query, for at most MAX_TRAFFIC_ZONES zones.
// Calls go through cf-read.ts as monitoring work: they use the monitoring share of each token's
// budget and wait while a backup or restore uses the token. Read-only: GraphQL queries only (sent as
// POST, which is how GraphQL takes them). Needs "Account Analytics Read" (accounts) or "Zone
// Analytics Read" (zones). An account or zone that cannot be read is listed with Cloudflare's reason;
// nothing is estimated for it.

const PARALLEL = 4;
const ZONE_BATCH = 10;
const ZONE_TAG = /^[A-Za-z0-9_-]{1,64}$/;

interface Window { since: string; until: string }
interface GqlBody<T> { data?: T | null; errors?: { message?: string }[] | null }
type Sum = { sum?: Partial<TrafficNumbers> };
type Sec = { count?: number; dimensions?: { action?: string } };

const TRAFFIC_FIELDS = 'sum { requests cachedRequests bytes cachedBytes pageViews }';

async function gql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await cfCall<T>(token, 'POST', '/graphql', { query, variables });
  const body = r.body as unknown as GqlBody<T> | null;
  if (r.status === 401 || r.status === 403) throw new Error(`the token cannot read analytics (${cfReason(r)})`);
  if (r.status !== 200 || !body) throw new Error(cfReason(r));
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).filter(Boolean).join('; ') || 'Cloudflare returned an error');
  if (!body.data) throw new Error('Cloudflare returned no data');
  return body.data;
}

const zero = (): TrafficNumbers => ({ requests: 0, cachedRequests: 0, bytes: 0, cachedBytes: 0, pageViews: 0 });
function addSum(t: TrafficNumbers, groups: Sum[] | undefined) {
  for (const g of groups ?? []) {
    t.requests += g.sum?.requests ?? 0; t.cachedRequests += g.sum?.cachedRequests ?? 0; t.bytes += g.sum?.bytes ?? 0;
    t.cachedBytes += g.sum?.cachedBytes ?? 0; t.pageViews += g.sum?.pageViews ?? 0;
  }
}
function addSec(m: Map<string, number>, groups: Sec[] | undefined) {
  for (const g of groups ?? []) { const a = g.dimensions?.action || 'unknown'; m.set(a, (m.get(a) ?? 0) + (g.count ?? 0)); }
}
const secOf = (m: Map<string, number>): SecurityNumbers => ({
  events: [...m.values()].reduce((a, b) => a + b, 0),
  byAction: [...m].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count),
});

const ACCOUNT_TRAFFIC = `query ($account: String!, $s1: Time!, $u1: Time!, $s0: Time!, $u0: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    cur: httpRequestsOverviewAdaptiveGroups(limit: 1, filter: { datetime_geq: $s1, datetime_lt: $u1 }) { ${TRAFFIC_FIELDS} }
    prev: httpRequestsOverviewAdaptiveGroups(limit: 1, filter: { datetime_geq: $s0, datetime_lt: $u0 }) { ${TRAFFIC_FIELDS} }
  } }
}`;
const ACCOUNT_SECURITY = `query ($account: String!, $s1: Time!, $u1: Time!, $s0: Time!, $u0: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    cur: firewallEventsAdaptiveGroups(limit: 50, filter: { datetime_geq: $s1, datetime_lt: $u1 }, orderBy: [count_DESC]) { count dimensions { action } }
    prev: firewallEventsAdaptiveGroups(limit: 50, filter: { datetime_geq: $s0, datetime_lt: $u0 }, orderBy: [count_DESC]) { count dimensions { action } }
  } }
}`;
const zoneQuery = (dataset: 'traffic' | 'security') => `query ($zones: [String!]!, $s1: Time!, $u1: Time!, $s0: Time!, $u0: Time!) {
  viewer { zones(filter: { zoneTag_in: $zones }) {
    ${dataset === 'traffic'
    ? `cur: httpRequestsOverviewAdaptiveGroups(limit: 1, filter: { datetime_geq: $s1, datetime_lt: $u1 }) { ${TRAFFIC_FIELDS} }
    prev: httpRequestsOverviewAdaptiveGroups(limit: 1, filter: { datetime_geq: $s0, datetime_lt: $u0 }) { ${TRAFFIC_FIELDS} }`
    : `cur: firewallEventsAdaptiveGroups(limit: 50, filter: { datetime_geq: $s1, datetime_lt: $u1 }, orderBy: [count_DESC]) { count dimensions { action } }
    prev: firewallEventsAdaptiveGroups(limit: 50, filter: { datetime_geq: $s0, datetime_lt: $u0 }, orderBy: [count_DESC]) { count dimensions { action } }`}
  } }
}`;

type Part = { cur?: Sum[]; prev?: Sum[] };
type SecPart = { cur?: Sec[]; prev?: Sec[] };

/** This period and the one before it, for `accountIds` (null: every account the tokens read). */
export async function accountTraffic(accountIds: string[] | null, cur: Window, prev: Window): Promise<TrafficSection> {
  const { accounts, problems: listProblems } = await accountTargets();
  const wanted = accountIds ? accounts.filter((a) => accountIds.includes(a.accountId)) : accounts;
  const problems: TrafficSection['problems'] = listProblems.map((p) => ({ scope: p.scope, error: p.error }));
  if (accountIds) for (const id of accountIds) if (!accounts.some((a) => a.accountId === id)) problems.push({ scope: `Account ${id}`, error: 'No stored token reads this account' });
  const list = wanted.slice(0, MAX_TRAFFIC_ACCOUNTS);
  if (wanted.length > list.length) problems.push({ scope: `${wanted.length - list.length} more accounts`, error: `A report reads at most ${MAX_TRAFFIC_ACCOUNTS} accounts` });
  const vars = { s1: cur.since, u1: cur.until, s0: prev.since, u0: prev.until };
  const t1 = zero(), t0 = zero(), s1 = new Map<string, number>(), s0 = new Map<string, number>();
  let read = 0, secRead = 0;
  await asMonitor({ calls: 0 }, () => inParallel(list, PARALLEL, async (a) => {
    const name = a.accountName || `Account ${a.accountId}`;
    try {
      const d = await gql<{ viewer?: { accounts?: Part[] } }>(a.token, ACCOUNT_TRAFFIC, { account: a.accountId, ...vars });
      const x = d.viewer?.accounts?.[0];
      addSum(t1, x?.cur); addSum(t0, x?.prev);
      read++;
    } catch (err) {
      problems.push({ scope: name, error: `traffic: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    try {
      const d = await gql<{ viewer?: { accounts?: SecPart[] } }>(a.token, ACCOUNT_SECURITY, { account: a.accountId, ...vars });
      const x = d.viewer?.accounts?.[0];
      addSec(s1, x?.cur); addSec(s0, x?.prev);
      secRead++;
    } catch (err) {
      problems.push({ scope: name, error: `security events: ${err instanceof Error ? err.message : String(err)}` });
    }
  }));
  return finish(read, secRead, list.length + (accountIds ? accountIds.filter((id) => !accounts.some((a) => a.accountId === id)).length : 0), 'accounts', t1, t0, s1, s0, problems);
}

/** The same for a list of zones (a tag report), at most MAX_TRAFFIC_ZONES of them. */
export async function zoneTraffic(zoneIds: string[], cur: Window, prev: Window): Promise<TrafficSection> {
  const problems: TrafficSection['problems'] = [];
  if (zoneIds.length > MAX_TRAFFIC_ZONES) {
    return {
      status: 'unavailable', note: `The tags match ${compactNum(zoneIds.length)} zones; traffic is read for at most ${MAX_TRAFFIC_ZONES} zones per report (use an account report for more)`,
      read: 0, of: zoneIds.length, unit: 'zones', current: null, previous: null, security: null, securityPrevious: null, problems,
    };
  }
  // Zones grouped by the token that reads them.
  const byToken = new Map<string, string[]>();
  for (const id of zoneIds.filter((z) => ZONE_TAG.test(z))) {
    try {
      const { token } = await zoneToken(id);
      byToken.set(token, [...(byToken.get(token) ?? []), id]);
    } catch (err) {
      problems.push({ scope: `Zone ${id}`, error: err instanceof Error ? err.message : 'No stored token reads this zone' });
    }
  }
  const jobs = [...byToken].flatMap(([token, ids]) => Array.from({ length: Math.ceil(ids.length / ZONE_BATCH) }, (_, i) => ({ token, ids: ids.slice(i * ZONE_BATCH, i * ZONE_BATCH + ZONE_BATCH) })));
  const vars = { s1: cur.since, u1: cur.until, s0: prev.since, u0: prev.until };
  const t1 = zero(), t0 = zero(), s1 = new Map<string, number>(), s0 = new Map<string, number>();
  let read = 0, secRead = 0;
  await asMonitor({ calls: 0 }, () => inParallel(jobs, PARALLEL, async (j) => {
    try {
      const d = await gql<{ viewer?: { zones?: Part[] } }>(j.token, zoneQuery('traffic'), { zones: j.ids, ...vars });
      for (const z of d.viewer?.zones ?? []) { addSum(t1, z.cur); addSum(t0, z.prev); }
      read += j.ids.length;
    } catch (err) {
      problems.push({ scope: `${compactNum(j.ids.length)} zone${j.ids.length === 1 ? '' : 's'}`, error: `traffic: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    try {
      const d = await gql<{ viewer?: { zones?: SecPart[] } }>(j.token, zoneQuery('security'), { zones: j.ids, ...vars });
      for (const z of d.viewer?.zones ?? []) { addSec(s1, z.cur); addSec(s0, z.prev); }
      secRead += j.ids.length;
    } catch (err) {
      problems.push({ scope: `${compactNum(j.ids.length)} zone${j.ids.length === 1 ? '' : 's'}`, error: `security events: ${err instanceof Error ? err.message : String(err)}` });
    }
  }));
  return finish(read, secRead, zoneIds.length, 'zones', t1, t0, s1, s0, problems);
}

function finish(read: number, secRead: number, of: number, unit: 'accounts' | 'zones', t1: TrafficNumbers, t0: TrafficNumbers, s1: Map<string, number>, s0: Map<string, number>, problems: TrafficSection['problems']): TrafficSection {
  if (!of) return { status: 'nothing', note: `No ${unit} in this report's scope`, read: 0, of: 0, unit, current: null, previous: null, security: null, securityPrevious: null, problems };
  if (!read) return { status: 'unavailable', note: problems[0]?.error ?? 'Nothing could be read', read, of, unit, current: null, previous: null, security: null, securityPrevious: null, problems };
  // Only what was read in full is shown: the security numbers only when every read account's (or zone's) were read too.
  const sec = secRead === read;
  return {
    status: t1.requests || t0.requests ? 'ok' : 'nothing', read, of, unit, current: t1, previous: t0,
    security: sec ? secOf(s1) : null, securityPrevious: sec ? secOf(s0) : null, problems,
    ...(sec ? {} : { note: 'Security events are left out: they could not be read for every account (or zone) whose traffic was read' }),
  };
}
