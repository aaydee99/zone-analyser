import 'server-only';
import { cfList, cfOne, inParallel } from '../cf-read';
import type { NewFinding } from '../monitor-store';
import type { Row } from '../monitor-types';
import { Problems, notAvailable, report, type CheckRunner } from './common';

// Is everything up: health checks and waiting rooms (per zone), tunnels and load-balancer pools (per
// account). A product the plan or token does not include is skipped quietly.

interface HealthCheck { id: string; name?: string; address?: string; type?: string; status?: string; failure_reason?: string; suspended?: boolean }
interface Room { id: string; name?: string; host?: string; path?: string; suspended?: boolean }
interface RoomStatus { status?: string; estimated_queued_users?: number; estimated_total_active_users?: number; max_estimated_time_minutes?: number }
interface Tunnel { id: string; name?: string; status?: string; conns_active_at?: string | null; deleted_at?: string | null }
interface Pool { id: string; name?: string; enabled?: boolean; healthy?: boolean; origins?: { name?: string; address?: string; enabled?: boolean }[] }

const quiet = async <T,>(p: Problems, scope: string, fn: () => Promise<T[]>): Promise<{ items: T[]; ok: boolean }> => {
  try { return { items: await fn(), ok: true }; } catch (err) { if (notAvailable(err)) return { items: [], ok: true }; p.add(scope, err); return { items: [], ok: false }; }
};

export const availability: CheckRunner = async (ctx) => {
  const started = Date.now();
  const p = new Problems();
  const [{ zones, problems: zp }, { accounts, problems: ap }] = await Promise.all([ctx.zones(), ctx.accounts()]);
  p.list.push(...zp, ...ap);
  const rows: Row[] = [];
  const findings: NewFinding[] = [];
  const read = new Set<string>();
  ctx.progress.total = zones.length + accounts.length;

  await inParallel(zones, 3, async (z) => {
    const scope = { zoneId: z.zoneId, zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName };
    const checks = await quiet<HealthCheck>(p, `${z.zoneName} · health checks`, () => cfList(z.token, `/zones/${z.zoneId}/healthchecks`, { signal: ctx.signal }));
    for (const h of checks.items) {
      const status = h.suspended ? 'suspended' : h.status ?? 'unknown';
      rows.push({ kind: 'Health check', name: h.name ?? h.id, where: z.zoneName, target: h.address ?? '', status, detail: h.failure_reason ?? '', _tone: status === 'healthy' ? 'ok' : status === 'unhealthy' ? 'bad' : 'warn' });
      if (status === 'unhealthy') findings.push({ key: `hc:${z.zoneId}:${h.id}`, severity: 'high', title: `Health check “${h.name ?? h.id}” is failing on ${z.zoneName}`, detail: h.failure_reason ?? `Cloudflare cannot reach ${h.address ?? 'the origin'}.`, ...scope });
    }
    const rooms = await quiet<Room>(p, `${z.zoneName} · waiting rooms`, () => cfList(z.token, `/zones/${z.zoneId}/waiting_rooms`, { signal: ctx.signal }));
    for (const r of rooms.items) {
      let st: RoomStatus = {};
      try { st = await cfOne<RoomStatus>(z.token, `/zones/${z.zoneId}/waiting_rooms/${r.id}/status`, ctx.signal); } catch { /* shown as unknown */ }
      const status = r.suspended ? 'suspended' : st.status ?? 'unknown';
      rows.push({ kind: 'Waiting room', name: r.name ?? r.id, where: z.zoneName, target: `${r.host ?? ''}${r.path ?? ''}`, status, detail: st.estimated_queued_users ? `${st.estimated_queued_users} queued · about ${st.max_estimated_time_minutes ?? '?'} min wait` : '', _tone: status === 'queueing' ? 'warn' : 'ok' });
      if (status === 'queueing') findings.push({ key: `wr:${z.zoneId}:${r.id}`, severity: 'medium', title: `Visitors are queueing in “${r.name ?? r.id}” on ${z.zoneName}`, detail: `${st.estimated_queued_users ?? 0} visitors waiting, about ${st.max_estimated_time_minutes ?? '?'} minutes.`, ...scope });
    }
    if (checks.ok && rooms.ok) read.add(z.zoneId);
    ctx.progress.done++;
  });

  for (const a of accounts) {
    const scope = { accountId: a.accountId, accountName: a.accountName || a.accountId };
    const tunnels = await quiet<Tunnel>(p, `${scope.accountName} · tunnels`, () => cfList(a.token, `/accounts/${a.accountId}/cfd_tunnel?is_deleted=false`, { signal: ctx.signal }));
    for (const t of tunnels.items.filter((x) => !x.deleted_at)) {
      const status = t.status ?? 'unknown';
      rows.push({ kind: 'Tunnel', name: t.name ?? t.id, where: scope.accountName, target: t.id, status, detail: t.conns_active_at ? `connected since ${t.conns_active_at}` : '', _tone: status === 'healthy' ? 'ok' : status === 'down' ? 'bad' : status === 'inactive' ? null : 'warn' });
      if (status === 'down' || status === 'degraded') findings.push({ key: `tunnel:${t.id}:${status}`, severity: status === 'down' ? 'high' : 'medium', title: `Tunnel “${t.name ?? t.id}” is ${status}`, detail: status === 'down' ? 'No cloudflared connector is connected: the services behind it are unreachable.' : 'Some connectors are not connected.', ...scope });
    }
    const pools = await quiet<Pool>(p, `${scope.accountName} · load-balancer pools`, () => cfList(a.token, `/accounts/${a.accountId}/load_balancers/pools`, { signal: ctx.signal }));
    for (const pool of pools.items) {
      const status = pool.enabled === false ? 'disabled' : pool.healthy === false ? 'unhealthy' : pool.healthy ? 'healthy' : 'unknown';
      const origins = pool.origins ?? [];
      rows.push({ kind: 'Pool', name: pool.name ?? pool.id, where: scope.accountName, target: `${origins.filter((o) => o.enabled !== false).length} of ${origins.length} origins on`, status, detail: '', _tone: status === 'healthy' ? 'ok' : status === 'unhealthy' ? 'bad' : 'warn' });
      if (status === 'unhealthy') findings.push({ key: `pool:${pool.id}`, severity: 'high', title: `Load-balancer pool “${pool.name ?? pool.id}” is unhealthy`, detail: 'Traffic fails over to other pools, or is refused if none is healthy.', ...scope });
    }
    if (tunnels.ok && pools.ok) read.add(a.accountId);
    ctx.progress.done++;
  }

  const order = { bad: 0, warn: 1, ok: 2, info: 3 } as Record<string, number>;
  rows.sort((x, y) => (order[x._tone ?? 'info'] ?? 3) - (order[y._tone ?? 'info'] ?? 3));
  const down = rows.filter((r) => r._tone === 'bad').length;
  return {
    report: report('availability', started, [
      { label: 'Monitored', value: rows.length },
      { label: 'Down or failing', value: down, tone: down ? 'bad' : 'ok' },
      { label: 'Degraded', value: rows.filter((r) => r._tone === 'warn').length, tone: rows.some((r) => r._tone === 'warn') ? 'warn' : 'ok' },
      { label: 'Healthy', value: rows.filter((r) => r._tone === 'ok').length, tone: 'ok' },
    ], [{
      key: 'status', title: 'Current status', description: 'Health checks need Pro or higher; load balancing and waiting rooms are paid products. What a zone or account does not have is left out.',
      columns: [{ key: 'kind', label: 'Kind' }, { key: 'name', label: 'Name' }, { key: 'where', label: 'Zone or account' }, { key: 'target', label: 'Target', kind: 'mono' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'detail', label: 'Detail' }],
      rows, empty: 'No health checks, waiting rooms, tunnels or load-balancer pools were found.',
    }], p.list, p.partial),
    findings, read,
  };
};
