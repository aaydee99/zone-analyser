import 'server-only';
import { cfList, cfOne } from '../cf-read';
import type { NewFinding } from '../monitor-store';
import type { Row } from '../monitor-types';
import { Problems, TONE_SORT, notAvailable, readStat, type CheckDef } from './common';

// Is everything up: health checks and waiting rooms (per zone), tunnels and load-balancer pools (per
// account). A product the plan or token does not include is skipped quietly, and a zone without any
// of them is looked at again only once a day, so the hourly checks go to the zones that have them.

interface HealthCheck { id: string; name?: string; address?: string; type?: string; status?: string; failure_reason?: string; suspended?: boolean }
interface Room { id: string; name?: string; host?: string; path?: string; suspended?: boolean }
interface RoomStatus { status?: string; estimated_queued_users?: number; estimated_total_active_users?: number; max_estimated_time_minutes?: number }
interface Tunnel { id: string; name?: string; status?: string; conns_active_at?: string | null; deleted_at?: string | null }
interface Pool { id: string; name?: string; enabled?: boolean; healthy?: boolean; origins?: { name?: string; address?: string; enabled?: boolean }[] }

const quiet = async <T,>(p: Problems, what: string, fn: () => Promise<T[]>): Promise<T[]> => {
  try { return await fn(); } catch (err) { if (!notAvailable(err)) p.add(what, err); return []; }
};

const tally = (rows: Row[]) => ({ monitored: rows.length, down: rows.filter((r) => r._tone === 'bad').length, degraded: rows.filter((r) => r._tone === 'warn').length, healthy: rows.filter((r) => r._tone === 'ok').length });
const sorted = (rows: Row[]) => rows.map((r) => ({ ...r, _sort: TONE_SORT[r._tone ?? 'info'] ?? 3 }));

export const availability: CheckDef = {
  id: 'availability', main: 'zone', idleHours: 24,
  units: {
    zone: async (z, ctx) => {
      const p = new Problems();
      const rows: Row[] = [];
      const findings: NewFinding[] = [];
      const scope = { zoneId: z.id, zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName };
      const checks = await quiet<HealthCheck>(p, 'health checks', () => cfList(z.token, `/zones/${z.id}/healthchecks`, { signal: ctx.signal }));
      for (const h of checks) {
        const status = h.suspended ? 'suspended' : h.status ?? 'unknown';
        rows.push({ kind: 'Health check', name: h.name ?? h.id, where: z.zoneName, target: h.address ?? '', status, detail: h.failure_reason ?? '', _tone: status === 'healthy' ? 'ok' : status === 'unhealthy' ? 'bad' : 'warn' });
        if (status === 'unhealthy') findings.push({ key: `hc:${z.id}:${h.id}`, severity: 'high', title: `Health check “${h.name ?? h.id}” is failing on ${z.zoneName}`, detail: h.failure_reason ?? `Cloudflare cannot reach ${h.address ?? 'the origin'}.`, ...scope });
      }
      const rooms = await quiet<Room>(p, 'waiting rooms', () => cfList(z.token, `/zones/${z.id}/waiting_rooms`, { signal: ctx.signal }));
      for (const r of rooms) {
        let st: RoomStatus = {};
        try { st = await cfOne<RoomStatus>(z.token, `/zones/${z.id}/waiting_rooms/${r.id}/status`, ctx.signal); } catch { /* shown as unknown */ }
        const status = r.suspended ? 'suspended' : st.status ?? 'unknown';
        rows.push({ kind: 'Waiting room', name: r.name ?? r.id, where: z.zoneName, target: `${r.host ?? ''}${r.path ?? ''}`, status, detail: st.estimated_queued_users ? `${st.estimated_queued_users} queued · about ${st.max_estimated_time_minutes ?? '?'} min wait` : '', _tone: status === 'queueing' ? 'warn' : 'ok' });
        if (status === 'queueing') findings.push({ key: `wr:${z.id}:${r.id}`, severity: 'medium', title: `Visitors are queueing in “${r.name ?? r.id}” on ${z.zoneName}`, detail: `${st.estimated_queued_users ?? 0} visitors waiting, about ${st.max_estimated_time_minutes ?? '?'} minutes.`, ...scope });
      }
      return { rows: { status: sorted(rows) }, findings, complete: p.complete, problems: p.list, counts: tally(rows), idle: p.complete && !rows.length };
    },
    account: async (a, ctx) => {
      const p = new Problems();
      const rows: Row[] = [];
      const findings: NewFinding[] = [];
      const scope = { accountId: a.accountId, accountName: a.accountName || a.accountId };
      const tunnels = await quiet<Tunnel>(p, 'tunnels', () => cfList(a.token, `/accounts/${a.accountId}/cfd_tunnel?is_deleted=false`, { signal: ctx.signal }));
      for (const t of tunnels.filter((x) => !x.deleted_at)) {
        const status = t.status ?? 'unknown';
        rows.push({ kind: 'Tunnel', name: t.name ?? t.id, where: scope.accountName, target: t.id, status, detail: t.conns_active_at ? `connected since ${t.conns_active_at}` : '', _tone: status === 'healthy' ? 'ok' : status === 'down' ? 'bad' : status === 'inactive' ? null : 'warn' });
        if (status === 'down' || status === 'degraded') findings.push({ key: `tunnel:${t.id}:${status}`, severity: status === 'down' ? 'high' : 'medium', title: `Tunnel “${t.name ?? t.id}” is ${status}`, detail: status === 'down' ? 'No cloudflared connector is connected: the services behind it are unreachable.' : 'Some connectors are not connected.', ...scope });
      }
      const pools = await quiet<Pool>(p, 'load-balancer pools', () => cfList(a.token, `/accounts/${a.accountId}/load_balancers/pools`, { signal: ctx.signal }));
      for (const pool of pools) {
        const status = pool.enabled === false ? 'disabled' : pool.healthy === false ? 'unhealthy' : pool.healthy ? 'healthy' : 'unknown';
        const origins = pool.origins ?? [];
        rows.push({ kind: 'Pool', name: pool.name ?? pool.id, where: scope.accountName, target: `${origins.filter((o) => o.enabled !== false).length} of ${origins.length} origins on`, status, detail: '', _tone: status === 'healthy' ? 'ok' : status === 'unhealthy' ? 'bad' : 'warn' });
        if (status === 'unhealthy') findings.push({ key: `pool:${pool.id}`, severity: 'high', title: `Load-balancer pool “${pool.name ?? pool.id}” is unhealthy`, detail: 'Traffic fails over to other pools, or is refused if none is healthy.', ...scope });
      }
      return { rows: { status: sorted(rows) }, findings, complete: p.complete, problems: p.list, counts: tally(rows), idle: p.complete && !rows.length };
    },
  },
  sections: [{
    key: 'status', title: 'Current status', description: 'Failing first. Health checks need Pro or higher; load balancing and waiting rooms are paid products. What a zone or account does not have is left out.',
    columns: [{ key: 'kind', label: 'Kind' }, { key: 'name', label: 'Name' }, { key: 'where', label: 'Zone or account' }, { key: 'target', label: 'Target', kind: 'mono' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'detail', label: 'Detail' }],
    empty: 'No health checks, waiting rooms, tunnels or load-balancer pools were found.',
  }],
  stats: (t) => [
    { label: 'Monitored', value: t.counts.monitored ?? 0 },
    { label: 'Down or failing', value: t.counts.down ?? 0, tone: t.counts.down ? 'bad' : 'ok' },
    { label: 'Degraded', value: t.counts.degraded ?? 0, tone: t.counts.degraded ? 'warn' : 'ok' },
    readStat(t, 'Zones and accounts read'),
  ],
};
