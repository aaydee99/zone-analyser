'use client';

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import type { ZoneListItem } from '@/lib/zone-catalog';
import type { Bar, DnsReport, Top, WorkersReport } from '@/lib/cf-insights';
import { Alert, Button, Card, Loading, PageHeader, SectionHeader, SkeletonChart, SkeletonStats, Stat, cx } from '@/components/ui';

type Tab = 'dns' | 'workers';
const DAYS = [1, 7, 30] as const;
import { compactNum as num, whole } from '@/lib/num';

function label(l: string, days: number) {
  const d = new Date(l.length === 10 ? `${l}T00:00:00Z` : l);
  return days === 1 ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** One bar per hour or day: the whole bar is the total, the crimson part (if any) the errors. */
function Bars({ series, days, total, part }: { series: Bar[]; days: number; total: string; part?: string }) {
  const max = Math.max(1, ...series.map((b) => b.value));
  if (!series.length) return <p className="px-5 py-10 text-center text-sm text-muted">No data in this period.</p>;
  return (
    <div className="px-5 pt-4 pb-3">
      <div className="flex h-40 items-end gap-[2px]" role="img" aria-label={`${total} per ${days === 1 ? 'hour' : 'day'}`}>
        {series.map((b) => {
          const h = (b.value / max) * 100;
          const e = b.extra && b.value ? (b.extra / b.value) * h : 0;
          return (
            <div key={b.label} className="group relative flex h-full flex-1 flex-col justify-end" title={`${label(b.label, days)}: ${whole.format(b.value)} ${total.toLowerCase()}${part ? `, ${whole.format(b.extra ?? 0)} ${part.toLowerCase()}` : ''}`}>
              <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-[3px]" style={{ height: `${Math.max(h, b.value ? 1.5 : 0)}%` }}>
                {e > 0 && <div className="w-full bg-bad" style={{ height: `${(e / h) * 100}%` }} />}
                <div className="w-full flex-1 bg-signal/85 group-hover:bg-signal" />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-faint"><span>{label(series[0].label, days)}</span><span>{label(series.at(-1)!.label, days)}</span></div>
      <div className="mt-2 flex gap-4 text-[11.5px] text-muted">
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-signal" />{total}</span>
        {part && <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-bad" />{part}</span>}
      </div>
    </div>
  );
}

function TopList({ title, rows, unit, extra, extra2 }: { title: string; rows: Top[]; unit: string; extra?: string; extra2?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card>
      <SectionHeader title={title} />
      {rows.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No data.</p> : (
        <ul className="space-y-2 px-5 py-4">
          {rows.map((r) => (
            <li key={r.name} className="text-[12.5px]">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-mono text-ink-2" title={r.name}>{r.name}</span>
                <span className="shrink-0 font-mono tabular-nums text-ink">{num(r.value)} <span className="text-faint">{unit}</span>
                  {extra && r.extra !== undefined && <span className={cx('ml-2', r.extra ? 'text-bad' : 'text-faint')}>{num(r.extra)} {extra}</span>}
                  {extra2 && r.extra2 !== undefined && <span className="ml-2 text-faint">{r.extra2} {extra2}</span>}
                </span>
              </div>
              <div className="mt-1 h-1 rounded-full bg-raised"><div className="h-1 rounded-full bg-signal/70" style={{ width: `${(r.value / max) * 100}%` }} /></div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>('dns');
  const [zones, setZones] = useState<ZoneListItem[] | null>(null);
  const [zoneId, setZoneId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [days, setDays] = useState<(typeof DAYS)[number]>(7);
  const [dns, setDns] = useState<DnsReport | null>(null);
  const [workers, setWorkers] = useState<WorkersReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    api<{ zones: ZoneListItem[] }>('/api/zone-explorer').then((r) => {
      setZones(r.zones);
      setZoneId((z) => z || r.zones[0]?.id || '');
      setAccountId((a) => a || r.zones.find((z) => z.accountId)?.accountId || '');
    }).catch((e) => setError((e as Error).message));
  }, []);
  const accounts = useMemo(() => {
    const m = new Map<string, string>();
    for (const z of zones ?? []) if (z.accountId) m.set(z.accountId, z.accountName || z.accountId);
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [zones]);

  useEffect(() => {
    const target = tab === 'dns' ? zoneId : accountId;
    if (!target) return;
    let live = true;
    setLoading(true); setError('');
    const fresh = refresh ? '&fresh=1' : '';
    const req = tab === 'dns'
      ? api<DnsReport>(`/api/analytics/dns?zoneId=${target}&days=${days}${fresh}`).then((r) => { if (live) setDns(r); })
      : api<WorkersReport>(`/api/analytics/workers?accountId=${target}&days=${days}${fresh}`).then((r) => { if (live) setWorkers(r); });
    req.catch((e) => { if (live) setError((e as Error).message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [tab, zoneId, accountId, days, refresh]);

  const current = tab === 'dns' ? (dns?.zoneId === zoneId && dns.days === days ? dns : null) : (workers?.accountId === accountId && workers.days === days ? workers : null);
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Cloudflare" title="DNS & Workers" description="DNS queries Cloudflare answered for a zone, and requests, errors and CPU time of the Workers in an account."
        actions={<Button variant="ghost" onClick={() => setRefresh((n) => n + 1)} loading={loading} icon={<RefreshCw className="size-4" />}>Refresh</Button>} />
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-line p-0.5" role="tablist" aria-label="Analytics">
          {(['dns', 'workers'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={cx('rounded-md px-3 py-1.5 text-[13px]', tab === t ? 'bg-raised text-ink' : 'text-muted hover:text-ink-2')}>{t === 'dns' ? 'DNS' : 'Workers'}</button>
          ))}
        </div>
        {tab === 'dns' ? (
          <select className="input !w-auto min-w-[220px]" aria-label="Zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
            {(zones ?? []).map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        ) : (
          <select className="input !w-auto min-w-[220px]" aria-label="Account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
        <div className="inline-flex rounded-lg border border-line p-0.5" role="group" aria-label="Period">
          {DAYS.map((d) => <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)} className={cx('rounded-md px-3 py-1.5 text-[13px]', days === d ? 'bg-raised text-ink' : 'text-muted hover:text-ink-2')}>{d === 1 ? '24 hours' : `${d} days`}</button>)}
        </div>
      </div>
      {error && <Alert tone="bad" title="Cloudflare could not answer">{error}</Alert>}
      {!current ? (
        !error && <Loading label="Loading analytics"><SkeletonStats count={3} className="mb-4" /><SkeletonChart /></Loading>
      ) : tab === 'dns' ? (() => {
        const r = current as DnsReport;
        const nx = r.codes.find((c) => c.name === 'NXDOMAIN')?.value ?? 0;
        return (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Queries" value={num(r.total)} />
              <Stat label="Per day" value={num(Math.round(r.total / r.days))} />
              <Stat label="NXDOMAIN" value={num(nx)} tone={nx && nx / Math.max(1, r.total) > 0.2 ? 'warn' : undefined} sub={r.total ? `${((nx / r.total) * 100).toFixed(1)}% of queries` : undefined} />
              <Stat label="Names queried" value={r.names.length >= 15 ? '15+' : r.names.length} />
            </div>
            <Card><SectionHeader title={`Queries per ${r.days === 1 ? 'hour' : 'day'}`} description={`${r.zoneName} · read ${fmtDate(r.generatedAt)}`} /><Bars series={r.series} days={r.days} total="Queries" /></Card>
            <div className="grid gap-4 lg:grid-cols-3">
              <TopList title="Top names" rows={r.names} unit="queries" />
              <TopList title="Record types" rows={r.types} unit="queries" />
              <TopList title="Response codes" rows={r.codes} unit="queries" />
            </div>
          </>
        );
      })() : (() => {
        const r = current as WorkersReport;
        const rate = r.requests ? (r.errors / r.requests) * 100 : 0;
        return (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Requests" value={num(r.requests)} />
              <Stat label="Errors" value={num(r.errors)} tone={r.errors ? 'bad' : 'ok'} />
              <Stat label="Error rate" value={`${rate.toFixed(2)}%`} tone={rate > 1 ? 'bad' : rate > 0.1 ? 'warn' : 'ok'} />
              <Stat label="Workers with traffic" value={r.scripts.length} />
            </div>
            <Card><SectionHeader title={`Requests per ${r.days === 1 ? 'hour' : 'day'}`} description={`${r.accountName || r.accountId} · read ${fmtDate(r.generatedAt)}`} /><Bars series={r.series} days={r.days} total="Requests" part="Errors" /></Card>
            <TopList title="Workers by requests" rows={r.scripts} unit="requests" extra="errors" extra2="ms CPU p99" />
          </>
        );
      })()}
    </div>
  );
}
