'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, HeartPulse, RefreshCw, Search } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import { CHECK, isCheckId } from '@/lib/monitor-types';
import { HEALTH_SORTS, explain, scoreTone, type HealthRow, type HealthSort, type HealthView } from '@/lib/zone-health-types';
import { Alert, Badge, Button, Card, EmptyState, Loading, PageHeader, SkeletonStats, SkeletonTable, Stat, cx } from '@/components/ui';
import { SeverityBadge } from '@/components/monitor-view';
import { useSnapshot } from '../monitoring/use-run';

import { whole } from '@/lib/num';
const FIRST = 20;
const MORE = 50;
const label = (c: string) => (isCheckId(c) ? CHECK[c].label : c);

/** Waits until `value` has stopped changing for `ms`. */
function useSettled<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function Score({ s }: { s: number }) {
  const tone = scoreTone(s);
  return <span className={cx('inline-flex w-11 justify-center rounded-md border px-1.5 py-0.5 font-mono text-[13px] font-semibold tabular-nums', tone === 'bad' ? 'border-bad/30 bg-bad/10 text-bad' : tone === 'warn' ? 'border-warn/30 bg-warn/10 text-warn' : 'border-ok/30 bg-ok/10 text-ok')}>{s}</span>;
}

function ZoneRow({ r }: { r: HealthRow }) {
  const [open, setOpen] = useState(false);
  const why = explain(r.breakdown, label);
  return (
    <>
      <tr className="border-b border-line/60 align-top last:border-0 hover:bg-raised/40">
        <td className="px-4 py-2.5"><Score s={r.score} /></td>
        <td className="px-4 py-2.5 font-medium text-ink">{r.zoneName || r.zoneId}</td>
        <td className="px-4 py-2.5 text-ink-2">{r.accountName ?? '—'}</td>
        <td className="px-4 py-2.5">{r.worst ? <SeverityBadge s={r.worst} /> : <span className="text-faint">—</span>}</td>
        <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-ink-2">{whole.format(r.openFindings)}</td>
        <td className="max-w-[360px] px-4 py-2.5 text-[12.5px] text-muted">{why[0] ?? 'Nothing takes points off.'}</td>
        <td className="px-4 py-2 text-right">
          {why.length > 0 && (
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Why ${r.zoneName} scores ${r.score}`} className="rounded-md p-1 text-muted hover:bg-raised hover:text-ink">
              <ChevronDown className={cx('size-4 transition-transform', open && 'rotate-180')} />
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line/60 bg-raised/30">
          <td />
          <td colSpan={6} className="px-4 py-3 text-[12.5px]">
            <ul className="space-y-1 text-ink-2">{why.map((w) => <li key={w}>{w}</li>)}</ul>
            <p className="mt-2 text-faint">100 minus these points · scored {fmtDate(r.computedAt)} · <Link className="text-signal hover:underline" href="/console/monitoring">open findings on Monitoring</Link></p>
          </td>
        </tr>
      )}
    </>
  );
}

export default function HealthPage() {
  const [account, setAccount] = useState('');
  const [tag, setTag] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<HealthSort>('score');
  const term = useSettled(q.trim());
  const tagTerm = useSettled(tag.trim().toLowerCase());
  const params = new URLSearchParams({ sort, limit: String(FIRST) });
  if (account) params.set('account', account);
  if (tagTerm) params.set('tag', tagTerm);
  if (term) params.set('q', term);
  const path = `/api/zone-health?${params}`;
  const { data, error, loading, reload, version } = useSnapshot<HealthView>(path);
  const [extra, setExtra] = useState<{ v: number; rows: HealthRow[] }>({ v: -1, rows: [] });
  const [more, setMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const added = extra.v === version ? extra.rows : [];
  const rows = data ? [...data.rows, ...added] : [];
  const summary = data?.summary;
  const accounts = data?.accounts ?? [];

  const loadMore = async () => {
    setMore(true);
    try {
      const p = new URLSearchParams(params); p.set('offset', String(rows.length)); p.set('limit', String(MORE));
      const page = await api<HealthView>(`/api/zone-health?${p}`);
      setExtra({ v: version, rows: [...added, ...page.rows] });
      setMoreError('');
    } catch (e) { setMoreError((e as Error).message); } finally { setMore(false); }
  };

  const filtered = !!(account || tagTerm || term);
  const title = sort === 'score' && !filtered ? `Worst ${FIRST} today` : 'Zones';
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Monitoring" title="Zone health" description="One score per zone, 0–100: open findings weighted by severity and check, checks that fail or never ran, the nearest certificate expiry and drift. From stored monitoring results — no Cloudflare calls."
        actions={<Button variant="ghost" loading={loading} onClick={reload} icon={<RefreshCw className="size-4" />}>Refresh</Button>} />
      {data && <p className="-mt-4 text-[12.5px] text-muted">{summary?.computedAt && <span title={fmtDate(summary.computedAt)}>last scored {fmtDate(summary.computedAt)} · </span>}<span title={fmtDate(data.generatedAt)}>as of {new Date(data.generatedAt).toLocaleTimeString()}</span></p>}
      {error && <Alert tone="bad" title="Zone health could not be read">{error}{data ? ' — what is shown is from before.' : ''}</Alert>}
      {!data && !error ? (
        <Loading label="Loading zone health"><SkeletonStats count={4} className="mb-5" /><SkeletonTable rows={10} cols={6} /></Loading>
      ) : data && (
        <>
          {summary && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Zones scored" value={whole.format(summary.zones)} />
              <Stat label="Average" value={summary.average ?? '—'} tone={summary.average === null ? undefined : scoreTone(summary.average)} />
              <Stat label="Below 50" value={whole.format(summary.poor)} tone={summary.poor ? 'bad' : 'ok'} />
              <Stat label="50 to 79" value={whole.format(summary.fair)} tone={summary.fair ? 'warn' : 'ok'} />
            </div>
          )}
          <Card>
            <div className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3">
              <label className="grid gap-1 text-[12px] text-muted">Account
                <select className="input !py-1.5 !text-[13px]" value={account} onChange={(e) => setAccount(e.target.value)}>
                  <option value="">All accounts</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({whole.format(a.zones)} · avg {a.average})</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-[12px] text-muted">Tag
                <input className="input !w-40 !py-1.5 !text-[13px]" placeholder="team:payments" value={tag} onChange={(e) => setTag(e.target.value)} />
              </label>
              <label className="grid gap-1 text-[12px] text-muted">Zone
                <span className="relative block">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
                  <input className="input !w-56 !py-1.5 !pl-8 !text-[13px]" placeholder="Name starts with, or zone ID" value={q} onChange={(e) => setQ(e.target.value)} />
                </span>
              </label>
              <label className="grid gap-1 text-[12px] text-muted">Sort
                <select className="input !py-1.5 !text-[13px]" value={sort} onChange={(e) => setSort(e.target.value as HealthSort)}>
                  {HEALTH_SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </label>
              <span className="ml-auto self-center font-mono text-[11px] text-faint">{whole.format(data.total)} zones</span>
            </div>
            <h2 className="px-5 pt-4 text-[15px] font-semibold">{title}</h2>
            {rows.length === 0 ? (
              <EmptyState icon={<HeartPulse className="size-5" />} title={filtered ? 'No zone matches' : 'No zone scored yet'}
                description={filtered ? 'Try another account, tag or name.' : 'Scores appear as monitoring reads each zone. Run the checks from Monitoring, then press Refresh.'} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-muted">
                      {['Score', 'Zone', 'Account', 'Worst', 'Findings', 'Why'].map((h) => <th key={h} className="px-4 py-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase">{h}</th>)}
                      <th className="px-4 py-2.5"><span className="sr-only">Details</span></th>
                    </tr>
                  </thead>
                  <tbody>{rows.map((r) => <ZoneRow key={r.zoneId} r={r} />)}</tbody>
                </table>
                {moreError && <p className="px-5 py-2 text-sm text-bad">{moreError}</p>}
                {data.total > rows.length && (
                  <div className="border-t border-line px-4 py-2.5 text-center">
                    <Button size="sm" variant="ghost" loading={more} onClick={loadMore}>Show more ({whole.format(data.total - rows.length)} left)</Button>
                  </div>
                )}
              </div>
            )}
          </Card>
          <p className="text-[12px] text-faint">
            Points off: 25 per critical finding, 10 per high, 4 per medium, 1 per low (at most 50 per check; certificate findings count half and drift findings not at all — they have their own part);
            3 per failing check and 1 per check never run; 30 for an expired certificate, 15 within 7 days, 5 within 30; 1 per drift change (at most 10). <Badge>Dismissed findings do not count.</Badge>
          </p>
        </>
      )}
    </div>
  );
}
