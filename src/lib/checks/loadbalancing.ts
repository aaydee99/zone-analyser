import 'server-only';
import { BudgetError, ReadError, cfCall, cfList, cfOne, cfReason, inParallel, ok } from '../cf-read';
import { db } from '../supabase';
import type { NewFinding } from '../monitor-store';
import type { Row } from '../monitor-types';
import { Problems, TONE_SORT, readStat, type CheckDef } from './common';

// Load balancing, read-only: every pool with its origins and their health in each region (per
// account), every load balancer with the pools it sends to (per zone), and the failovers of the last
// 24 hours — when a load balancer started sending traffic to another pool — from the Load Balancing
// analytics (GraphQL loadBalancingRequestsAdaptiveGroups). Health events as such are not in the public
// API any more; a change of the selected pool is what they caused. Nothing here drains or toggles.
// Accounts without pools and zones without load balancers cost one call a week.

interface Origin { name?: string; address?: string; enabled?: boolean; weight?: number }
interface Pool { id: string; name?: string; enabled?: boolean; healthy?: boolean; minimum_origins?: number; monitor?: string | null; origins?: Origin[]; check_regions?: string[] | null; description?: string }
interface PoolHealth { pool_id?: string; pop_health?: Record<string, { healthy?: boolean; origins?: Record<string, { healthy?: boolean; failure_reason?: string; response_code?: number; rtt?: string }>[] }> }
interface Monitor { id: string; type?: string; description?: string; path?: string; interval?: number }
interface Lb { id: string; name: string; enabled?: boolean; proxied?: boolean; steering_policy?: string; default_pools?: string[]; fallback_pool?: string; session_affinity?: string }

/** Pools whose health is read per account and run (one call each). */
const MAX_POOL_HEALTH = 100;
const EVENTS_HOURS = 24;

const quiet = async <T,>(p: Problems, what: string, fn: () => Promise<T[]>): Promise<T[]> => {
  try { return await fn(); } catch (err) { p.skip(what, err); return []; }
};

/** Origin → per region health, from a pool's health answer. */
function originHealth(h: PoolHealth | null): Map<string, { up: number; down: number; reasons: Set<string>; rtt: string }> {
  const out = new Map<string, { up: number; down: number; reasons: Set<string>; rtt: string }>();
  for (const region of Object.values(h?.pop_health ?? {})) {
    for (const entry of region.origins ?? []) {
      for (const [addr, o] of Object.entries(entry ?? {})) {
        const cur = out.get(addr) ?? { up: 0, down: 0, reasons: new Set<string>(), rtt: '' };
        if (o.healthy) cur.up++; else { cur.down++; if (o.failure_reason) cur.reasons.add(o.failure_reason); }
        if (o.rtt && !cur.rtt) cur.rtt = o.rtt;
        out.set(addr, cur);
      }
    }
  }
  return out;
}

/** The account's pools as the account unit stored them: id → name and health. */
async function storedPools(accountId: string): Promise<Map<string, { name: string; status: string }>> {
  const out = new Map<string, { name: string; status: string }>();
  try {
    const { data } = await db().from('monitor_rows').select('data').eq('check_id', 'loadbalancing').eq('section', 'pools').eq('scope_kind', 'account').eq('scope_id', accountId).limit(1000);
    for (const r of (data ?? []) as { data: Row }[]) if (r.data.poolId) out.set(String(r.data.poolId), { name: String(r.data.pool ?? r.data.poolId), status: String(r.data.status ?? '') });
  } catch { /* not stored yet: shown by id */ }
  return out;
}

const EVENTS_QUERY = `query Failovers($zoneTag: string, $since: Time, $until: Time) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    loadBalancingRequestsAdaptiveGroups(limit: 5000, filter: { datetime_geq: $since, datetime_leq: $until }, orderBy: [datetimeFifteenMinutes_ASC]) {
      count dimensions { datetimeFifteenMinutes lbName selectedPoolName }
    }
  } }
}`;

interface Bucket { count?: number; dimensions?: { datetimeFifteenMinutes?: string; lbName?: string; selectedPoolName?: string } }

/** Times a load balancer's busiest pool changed from one 15-minute window to the next. */
export function failovers(groups: Bucket[]): { lb: string; at: string; from: string; to: string }[] {
  const per = new Map<string, Map<string, Map<string, number>>>();
  for (const g of groups) {
    const lb = g.dimensions?.lbName ?? '', at = g.dimensions?.datetimeFifteenMinutes ?? '', pool = g.dimensions?.selectedPoolName ?? '';
    if (!lb || !at) continue;
    const byTime = per.get(lb) ?? new Map<string, Map<string, number>>();
    const counts = byTime.get(at) ?? new Map<string, number>();
    counts.set(pool, (counts.get(pool) ?? 0) + (g.count ?? 0));
    byTime.set(at, counts);
    per.set(lb, byTime);
  }
  const out: { lb: string; at: string; from: string; to: string }[] = [];
  for (const [lb, byTime] of per) {
    let last = '';
    for (const at of [...byTime.keys()].sort()) {
      const top = [...byTime.get(at)!].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      if (last && top && top !== last) out.push({ lb, at, from: last, to: top });
      if (top) last = top;
    }
  }
  return out;
}

export const loadbalancing: CheckDef = {
  id: 'loadbalancing', main: 'account', every: { zone: 6 }, idleHours: 168,
  units: {
    account: async (a, ctx) => {
      const p = new Problems();
      const scope = { accountId: a.accountId, accountName: a.accountName || a.accountId };
      const pools = await quiet<Pool>(p, 'load-balancer pools', () => cfList(a.token, `/accounts/${a.accountId}/load_balancers/pools`, { signal: ctx.signal }));
      if (!pools.length) return { rows: {}, findings: [], complete: p.complete, problems: p.list, idle: p.complete };
      const monitors = await quiet<Monitor>(p, 'load-balancer monitors', () => cfList(a.token, `/accounts/${a.accountId}/load_balancers/monitors`, { signal: ctx.signal }));
      const monitorName = new Map(monitors.map((m) => [m.id, `${(m.type ?? 'http').toUpperCase()} ${m.path ?? ''}`.trim() + (m.description ? ` · ${m.description}` : '')]));
      const health = new Map<string, PoolHealth | null>();
      await inParallel(pools.filter((x) => x.enabled !== false && x.monitor).slice(0, MAX_POOL_HEALTH), 4, async (pool) => {
        try { health.set(pool.id, await cfOne<PoolHealth>(a.token, `/accounts/${a.accountId}/load_balancers/pools/${pool.id}/health`, ctx.signal)); } catch (err) { p.skip('pool health', err); health.set(pool.id, null); }
      });
      const poolRows: Row[] = [], originRows: Row[] = [];
      const findings: NewFinding[] = [];
      let originsDown = 0;
      for (const pool of pools) {
        const name = pool.name ?? pool.id;
        const status = pool.enabled === false ? 'disabled' : pool.healthy === false ? 'unhealthy' : pool.healthy ? 'healthy' : pool.monitor ? 'unknown' : 'no monitor';
        const origins = pool.origins ?? [];
        const oh = originHealth(health.get(pool.id) ?? null);
        const regions = Object.values(health.get(pool.id)?.pop_health ?? {});
        poolRows.push({
          poolId: pool.id, accountId: a.accountId, account: scope.accountName, pool: name, status, monitor: pool.monitor ? monitorName.get(pool.monitor) ?? pool.monitor : '',
          origins: `${origins.filter((o) => o.enabled !== false).length} of ${origins.length} on`, minimum: pool.minimum_origins ?? 1,
          regions: regions.length ? `${regions.filter((r) => r.healthy).length} of ${regions.length} healthy` : '',
          _tone: status === 'healthy' ? 'ok' : status === 'unhealthy' ? 'bad' : status === 'disabled' ? 'info' : 'warn',
        });
        for (const o of origins) {
          const h = o.address ? oh.get(o.address) : undefined;
          const st = o.enabled === false ? 'disabled' : !h ? (pool.monitor ? 'unknown' : 'not monitored') : !h.down ? 'healthy' : !h.up ? 'unhealthy' : 'degraded';
          originRows.push({
            account: scope.accountName, pool: name, origin: o.name ?? o.address ?? '', address: o.address ?? '', weight: o.weight ?? 1, status: st,
            regions: h ? `${h.up} of ${h.up + h.down} regions healthy` : '', reason: h ? [...h.reasons].join('; ') : '', rtt: h?.rtt ?? '',
            _tone: st === 'healthy' ? 'ok' : st === 'unhealthy' ? 'bad' : st === 'disabled' ? 'info' : 'warn',
          });
          if (pool.enabled !== false && (st === 'unhealthy' || st === 'degraded')) {
            originsDown += st === 'unhealthy' ? 1 : 0;
            findings.push({
              key: `lb:${a.accountId}:${pool.id}:${o.address ?? o.name}`, severity: st === 'unhealthy' ? 'medium' : 'low', ...scope,
              title: `Origin ${o.name ?? o.address} in pool “${name}” is ${st}`,
              detail: `${h!.down} of ${h!.up + h!.down} regions see it failing${h!.reasons.size ? `: ${[...h!.reasons].join('; ')}` : ''}.`,
            });
          }
        }
      }
      const sort = (rows: Row[]) => rows.map((r) => ({ ...r, _sort: TONE_SORT[r._tone ?? 'info'] ?? 3 }));
      return {
        rows: { pools: sort(poolRows), origins: sort(originRows) }, findings, complete: p.complete, problems: p.list,
        counts: { pools: pools.length, poolsDown: poolRows.filter((r) => r._tone === 'bad').length, origins: originRows.length, originsDown },
      };
    },
    zone: async (z, ctx) => {
      const p = new Problems();
      const scope = { zoneId: z.id, zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName };
      const lbs = await quiet<Lb>(p, 'load balancers', () => cfList(z.token, `/zones/${z.id}/load_balancers`, { signal: ctx.signal }));
      if (!lbs.length) return { rows: {}, findings: [], complete: p.complete, problems: p.list, idle: p.complete };
      const pools = await storedPools(z.accountId);
      const findings: NewFinding[] = [];
      const lbRows: Row[] = lbs.map((lb) => {
        const ids = [...new Set([...(lb.default_pools ?? []), ...(lb.fallback_pool ? [lb.fallback_pool] : [])])];
        const known = ids.map((id) => pools.get(id)).filter((x): x is { name: string; status: string } => !!x);
        const healthy = known.filter((x) => x.status === 'healthy').length;
        const allDown = known.length === ids.length && ids.length > 0 && !healthy && known.some((x) => x.status === 'unhealthy');
        const status = lb.enabled === false ? 'disabled' : allDown ? 'no healthy pool' : known.length < ids.length ? 'pools not read yet' : healthy < ids.length ? 'degraded' : 'healthy';
        if (lb.enabled !== false && allDown) findings.push({ key: `lb:${z.id}:${lb.id}:down`, severity: 'critical', ...scope, title: `Load balancer ${lb.name} has no healthy pool`, detail: 'Every default and fallback pool is unhealthy: visitors get errors.' });
        else if (lb.enabled !== false && status === 'degraded') findings.push({ key: `lb:${z.id}:${lb.id}:degraded`, severity: 'medium', ...scope, title: `Load balancer ${lb.name} is running on fewer pools`, detail: `${healthy} of ${ids.length} pools healthy.` });
        return {
          zone: z.zoneName, account: z.accountName, lb: lb.name, status, steering: lb.steering_policy || 'off', proxied: !!lb.proxied,
          pools: (lb.default_pools ?? []).map((id) => pools.get(id)?.name ?? id).join(', '), fallback: lb.fallback_pool ? pools.get(lb.fallback_pool)?.name ?? lb.fallback_pool : '',
          _tone: status === 'healthy' ? 'ok' : status === 'no healthy pool' ? 'bad' : status === 'disabled' ? 'info' : 'warn',
        } as Row;
      });
      // Failovers in the last 24 hours, from the analytics.
      const events: Row[] = [];
      const until = new Date(), since = new Date(until.getTime() - EVENTS_HOURS * 3_600_000);
      try {
        const r = await cfCall<unknown>(z.token, 'POST', '/graphql', { query: EVENTS_QUERY, variables: { zoneTag: z.id, since: since.toISOString(), until: until.toISOString() } }, ctx.signal);
        const body = r.body as unknown as { data?: { viewer?: { zones?: { loadBalancingRequestsAdaptiveGroups?: Bucket[] }[] } }; errors?: { message?: string }[] | null } | null;
        const why = body?.errors?.map((e) => e.message).filter(Boolean).join('; ') || cfReason(r);
        // GraphQL answers a refused read with 200 and an error: counted as the token lacking Analytics Read.
        if (!ok(r) || body?.errors?.length) p.skip('load-balancing analytics', new ReadError(r.status === 200 ? (/authoriz|permission|access/i.test(why) ? 403 : 502) : r.status, why));
        else for (const f of failovers(body?.data?.viewer?.zones?.[0]?.loadBalancingRequestsAdaptiveGroups ?? []).slice(-200)) events.push({ zone: z.zoneName, lb: f.lb, at: f.at, from: f.from, to: f.to, _tone: 'warn', _sort: -Date.parse(f.at) });
      } catch (err) { if (err instanceof BudgetError || (err instanceof Error && err.name === 'AbortError')) throw err; p.skip('load-balancing analytics', err); }
      return {
        rows: { lbs: lbRows.map((r) => ({ ...r, _sort: TONE_SORT[r._tone ?? 'info'] ?? 3 })), events }, findings, complete: p.complete, problems: p.list,
        counts: { lbs: lbs.length, lbsDown: lbRows.filter((r) => r._tone === 'bad').length, failovers: events.length },
      };
    },
  },
  sections: [
    { key: 'lbs', title: 'Load balancers', description: 'Unhealthy first. Pool health comes from each account’s last read of its pools.',
      columns: [{ key: 'lb', label: 'Hostname', kind: 'mono' }, { key: 'zone', label: 'Zone' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'steering', label: 'Steering' }, { key: 'pools', label: 'Default pools' }, { key: 'fallback', label: 'Fallback' }, { key: 'proxied', label: 'Proxied', kind: 'bool' }],
      empty: 'No load balancers were found in the zones the tokens can read.' },
    { key: 'pools', title: 'Pools', columns: [{ key: 'pool', label: 'Pool' }, { key: 'account', label: 'Account' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'origins', label: 'Origins' }, { key: 'minimum', label: 'Minimum', kind: 'number' }, { key: 'regions', label: 'Regions' }, { key: 'monitor', label: 'Monitor' }],
      empty: 'No pools.' },
    { key: 'origins', title: 'Origins', description: 'Health as each checking region sees it.',
      columns: [{ key: 'origin', label: 'Origin' }, { key: 'address', label: 'Address', kind: 'mono' }, { key: 'pool', label: 'Pool' }, { key: 'account', label: 'Account' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'regions', label: 'Regions' }, { key: 'reason', label: 'Failure' }, { key: 'rtt', label: 'RTT', kind: 'mono' }],
      empty: 'No origins.' },
    { key: 'events', title: 'Failovers in the last 24 hours', description: 'When a load balancer sent most of its traffic to a different pool than in the 15 minutes before (from Load Balancing analytics).',
      columns: [{ key: 'at', label: 'When', kind: 'date' }, { key: 'lb', label: 'Load balancer', kind: 'mono' }, { key: 'zone', label: 'Zone' }, { key: 'from', label: 'From pool' }, { key: 'to', label: 'To pool' }],
      empty: 'No failovers in the last 24 hours.' },
  ],
  stats: (t) => [
    { label: 'Load balancers', value: t.counts.lbs ?? 0 },
    { label: 'Pools unhealthy', value: `${t.counts.poolsDown ?? 0} of ${t.counts.pools ?? 0}`, tone: t.counts.poolsDown ? 'bad' : 'ok' },
    { label: 'Origins unhealthy', value: `${t.counts.originsDown ?? 0} of ${t.counts.origins ?? 0}`, tone: t.counts.originsDown ? 'warn' : 'ok' },
    readStat(t, 'Zones and accounts read'),
  ],
};
