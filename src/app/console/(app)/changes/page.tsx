'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Copy, FileClock, Lock, RefreshCw } from 'lucide-react';
import { api, copyText, fmtDate } from '@/lib/client';
import { ACTIVITY, AREA_LABEL, CHANGE_AREA, describeChange, reportText, type ChangeArea, type ChangeReport } from '@/lib/audit-changes';
import { Badge, Button, Card, EmptyState, PageHeader, Stat, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useMe } from '@/components/me';

const RANGES = [
  { days: 1, label: 'Last 24 hours' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
];

const AREA_TONE: Record<ChangeArea, 'signal' | 'warn' | 'info' | 'neutral'> = {
  users: 'warn', credentials: 'signal', presets: 'neutral', settings: 'info', runs: 'neutral', approvals: 'warn', account: 'neutral',
};

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export default function ChangesPage() {
  const toast = useToast();
  const { can } = useMe();
  const allowed = can('audit:read');
  const [days, setDays] = useState(7);
  const [area, setArea] = useState<ChangeArea | ''>('');
  const [report, setReport] = useState<ChangeReport | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setReport(await api<ChangeReport>(`/api/audit/changes?days=${days}`)); }
    catch (e) { toast((e as Error).message, 'bad'); }
    finally { setLoading(false); }
  }, [days, toast]);
  useEffect(() => { if (allowed) load(); }, [load, allowed]);

  const areaCounts = useMemo(() => {
    const m = new Map<ChangeArea, number>();
    for (const c of report?.changes ?? []) m.set(CHANGE_AREA[c.action], (m.get(CHANGE_AREA[c.action]) ?? 0) + 1);
    return m;
  }, [report]);

  const byDay = useMemo(() => {
    const groups: { day: string; items: ChangeReport['changes'] }[] = [];
    for (const c of report?.changes ?? []) {
      if (area && CHANGE_AREA[c.action] !== area) continue;
      const d = dayLabel(c.at);
      if (groups[groups.length - 1]?.day !== d) groups.push({ day: d, items: [] });
      groups[groups.length - 1].items.push(c);
    }
    return groups;
  }, [report, area]);

  if (!allowed) {
    return <Card className="rise mx-auto mt-6 max-w-lg"><EmptyState icon={<Lock className="size-5" />} title="Admins only" description="Recent changes come from the audit log, which is visible to admins and super admins." /></Card>;
  }

  const a = report?.activity ?? {};
  return (
    <div className="rise">
      <PageHeader
        eyebrow="Access"
        title="Recent changes"
        description="What changed in the console (users, credentials, presets, settings, tools), read from the audit log."
        actions={(
          <div className="flex gap-2">
            <Button icon={<RefreshCw className={cx('size-4', loading && 'animate-spin')} />} onClick={load} disabled={loading}>Refresh</Button>
            <Button icon={<Copy className="size-4" />} disabled={!report}
              onClick={async () => { if (report) { await copyText(reportText(report)); toast('Summary copied as text'); } }}>Copy summary</Button>
          </div>
        )}
      />

      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Period">
        {RANGES.map((r) => (
          <button key={r.days} onClick={() => setDays(r.days)} aria-pressed={days === r.days}
            className={cx('rounded-lg border px-3 py-1.5 text-[13px] transition-colors', days === r.days ? 'border-line-strong bg-raised text-ink' : 'border-transparent text-muted hover:text-ink-2')}>
            {r.label}
          </button>
        ))}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Changes" value={report ? report.changes.length : '—'} sub={report ? `since ${fmtDate(report.since)}` : 'Loading…'} />
        <Stat label="People who made changes" value={report ? report.people.length : '—'} sub={report?.people[0] ? `most: ${report.people[0].email}` : 'nobody'} />
        <Stat label="Failed sign-ins" value={report ? a.failedSignIns ?? 0 : '—'} sub={`${a.signIns ?? 0} successful`} tone={(a.failedSignIns ?? 0) > 0 ? 'bad' : undefined} />
        <Stat label="Secrets revealed" value={report ? a.reveals ?? 0 : '—'} sub={`${a.vaultUnlocks ?? 0} vault unlock${a.vaultUnlocks === 1 ? '' : 's'}`} tone={(a.reveals ?? 0) > 0 ? 'warn' : undefined} />
      </div>

      {report?.truncated && (
        <p className="mb-4 rounded-lg border border-warn/30 bg-warn/10 px-4 py-2.5 text-[13px] text-warn">
          This period has more audit entries than one report reads. The newest are shown; use the <Link href="/audit" className="underline">audit log</Link> for older ones.
        </p>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-5 py-3" role="group" aria-label="Area">
            <button onClick={() => setArea('')} aria-pressed={area === ''}
              className={cx('rounded-lg border px-2.5 py-1 text-[12.5px] transition-colors', area === '' ? 'border-line-strong bg-raised text-ink' : 'border-transparent text-muted hover:text-ink-2')}>
              All <span className="tabular-nums text-faint">{report?.changes.length ?? 0}</span>
            </button>
            {(Object.keys(AREA_LABEL) as ChangeArea[]).filter((k) => areaCounts.get(k)).map((k) => (
              <button key={k} onClick={() => setArea(k)} aria-pressed={area === k}
                className={cx('rounded-lg border px-2.5 py-1 text-[12.5px] transition-colors', area === k ? 'border-line-strong bg-raised text-ink' : 'border-transparent text-muted hover:text-ink-2')}>
                {AREA_LABEL[k]} <span className="tabular-nums text-faint">{areaCounts.get(k)}</span>
              </button>
            ))}
          </div>

          {report && byDay.length === 0 ? (
            <EmptyState icon={<FileClock className="size-5" />} title="No changes in this period"
              description="Nothing was added, edited or removed. Sign-ins and backup runs are counted on the right." />
          ) : (
            <div className="divide-y divide-line/60">
              {byDay.map((g) => (
                <section key={g.day} className="px-5 py-4">
                  <h2 className="eyebrow mb-3">{g.day}</h2>
                  <ol className="space-y-3">
                    {g.items.map((c) => (
                      <li key={c.id} className="grid grid-cols-[68px_minmax(0,1fr)] gap-3 text-[13px]">
                        <time className="pt-0.5 font-mono text-[11.5px] whitespace-nowrap text-muted tabular-nums" dateTime={c.at} title={fmtDate(c.at)}>{timeLabel(c.at)}</time>
                        <div className="min-w-0">
                          <p className="text-ink break-words">{describeChange(c)}</p>
                          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                            <span>{c.actorEmail ?? 'unknown'}</span>
                            <Badge tone={AREA_TONE[CHANGE_AREA[c.action]]}>{AREA_LABEL[CHANGE_AREA[c.action]]}</Badge>
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
              {!report && <p className="px-5 py-6 text-[13px] text-muted">Loading…</p>}
            </div>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <h2 className="border-b border-line px-5 py-4 text-[15px] font-semibold">Who made changes</h2>
            {report?.people.length ? (
              <ul className="space-y-2 px-5 py-4 text-[13px]">
                {report.people.map((p) => (
                  <li key={p.email} className="flex items-center justify-between gap-3">
                    <span className="truncate text-ink-2" title={p.email}>{p.email}</span>
                    <span className="font-mono tabular-nums text-muted">{p.changes}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="px-5 py-4 text-[13px] text-muted">{report ? 'Nobody' : 'Loading…'}</p>}
          </Card>

          <Card>
            <h2 className="border-b border-line px-5 py-4 text-[15px] font-semibold">Other activity</h2>
            <ul className="space-y-2 px-5 py-4 text-[13px]">
              {ACTIVITY.map((x) => {
                const n = a[x.key] ?? 0;
                return (
                  <li key={x.key} className="flex items-center justify-between gap-3">
                    <span className="text-ink-2">{x.label}</span>
                    <span className={cx('font-mono tabular-nums', n > 0 && x.tone === 'bad' ? 'text-bad' : n > 0 && x.tone === 'warn' ? 'text-warn' : 'text-muted')}>{report ? n : '—'}</span>
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-line px-5 py-3 text-[12.5px]">
              <Link href="/audit" className="text-muted hover:text-ink">Full audit log →</Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
