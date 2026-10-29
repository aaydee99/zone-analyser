'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, Circle, DatabaseBackup, History, RotateCcw } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import type { CredentialOption } from '@/lib/kinds';
import type { RunMeta } from '@/lib/run-types';
import type { RestoreHistory, RestoreSummary } from '@/lib/restore-history';
import { useMe } from '@/components/me';
import { OutcomeBadge, RestoreTable } from '@/components/restore-table';
import { Badge, Button, Card, EmptyState, PageHeader, Stat, cx } from '@/components/ui';

interface Check { ok: boolean; detail: string }
interface SystemCheck { terraform: Check }

const DAY = 86_400_000;
const DAYS = 30;
/** Completed: applied, or the zone already matched the backup. */
const isApplied = (r: RestoreSummary) => r.outcome === 'applied' || r.outcome === 'applied-unverified' || r.outcome === 'matched';
const isFailed = (r: RestoreSummary) => r.outcome === 'failed' || r.outcome === 'cancelled' || r.outcome === 'plan-failed' || r.outcome === 'interrupted';

/** Restores per day for the last 30 days, by how they ended: stacked bars with a hover readout. */
function Activity({ restores }: { restores: RestoreSummary[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const days = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return Array.from({ length: DAYS }, (_, i) => {
      const start = today.getTime() - (DAYS - 1 - i) * DAY;
      const mine = restores.filter((r) => { const t = Date.parse(r.createdAt); return t >= start && t < start + DAY; });
      return { start, applied: mine.filter(isApplied).length, failed: mine.filter(isFailed).length, other: mine.filter((r) => !isApplied(r) && !isFailed(r)).length };
    });
  }, [restores]);
  const max = Math.max(1, ...days.map((d) => d.applied + d.failed + d.other));
  const totals = days.reduce((t, d) => ({ applied: t.applied + d.applied, failed: t.failed + d.failed, other: t.other + d.other }), { applied: 0, failed: 0, other: 0 });
  const series = [
    { key: 'applied', label: 'Applied or already matching', cls: 'bg-ok' },
    { key: 'failed', label: 'Failed, cancelled or interrupted', cls: 'bg-bad' },
    { key: 'other', label: 'Not applied / open', cls: 'bg-line-strong' },
  ] as const;
  const shown = hover === null ? null : days[hover];
  const dayLabel = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold">Restores, last 30 days</h2>
          <p className="mt-0.5 h-4 text-xs text-muted">
            {shown ? `${dayLabel(shown.start)}: ${shown.applied} applied · ${shown.failed} failed · ${shown.other} not applied` : 'Hover a day for its numbers'}
          </p>
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5"><span className={cx('size-2.5 rounded-sm', s.cls)} aria-hidden />{s.label} <span className="tabular-nums text-muted">{totals[s.key]}</span></li>
          ))}
        </ul>
      </div>
      <div className="px-5 pt-4 pb-3">
        <div className="flex h-28 items-end gap-[3px]" role="img" aria-label={`Restores per day: ${totals.applied} applied, ${totals.failed} failed, ${totals.other} not applied in the last 30 days`}>
          {days.map((d, i) => {
            const n = d.applied + d.failed + d.other;
            return (
              <button key={d.start} type="button" className="relative flex h-full flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                aria-label={`${dayLabel(d.start)}: ${d.applied} applied, ${d.failed} failed, ${d.other} not applied`}>
                <span className={cx('absolute inset-0 rounded-sm', hover === i && 'bg-raised/70')} aria-hidden />
                {n === 0 ? <span className="relative h-px w-full bg-line" aria-hidden /> : (
                  <span className="relative flex w-full flex-col-reverse gap-[2px]" style={{ height: `${(n / max) * 100}%` }} aria-hidden>
                    {series.map((s) => d[s.key] > 0 && <span key={s.key} className={cx('w-full last:rounded-t-[4px]', s.cls)} style={{ flexGrow: d[s.key] }} />)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-faint"><span>{dayLabel(days[0].start)}</span><span>today</span></div>
      </div>
    </Card>
  );
}

export default function RestoreOverview() {
  const { activeRestore } = useMe();
  const [history, setHistory] = useState<RestoreHistory | null>(null);
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [creds, setCreds] = useState<CredentialOption[]>([]);
  const [sys, setSys] = useState<SystemCheck | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const load = () => api<RestoreHistory>('/api/restore/history').then(setHistory).catch(() => {});
    Promise.all([
      load(),
      api<{ runs: RunMeta[] }>('/api/runs').then((r) => setRuns(r.runs)),
      api<{ options: CredentialOption[] }>('/api/credentials/options').then((r) => setCreds(r.options)),
      api<{ check: SystemCheck }>('/api/system').then((r) => setSys(r.check)),
    ]).catch(() => {}).finally(() => setLoaded(true));
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const restores = useMemo(() => history?.restores ?? [], [history]);
  const stats = useMemo(() => {
    const ended = restores.filter((r) => isApplied(r) || r.outcome === 'failed');
    const applied = restores.filter(isApplied);
    return {
      lastApplied: applied[0],
      rate: ended.length ? Math.round((applied.length / ended.length) * 100) : null,
      ended: ended.length,
      verified: applied.filter((r) => r.outcome === 'applied').length,
      applied: applied.length,
      month: restores.filter((r) => Date.now() - Date.parse(r.createdAt) < 30 * DAY).length,
      zones: new Set(applied.map((r) => r.zone.name)).size,
    };
  }, [restores]);
  const latest = restores[0];
  const backups = runs.filter((r) => r.status === 'succeeded');

  const steps = [
    { done: creds.some((c) => c.kind === 'cloudflare'), label: 'A Cloudflare API token with R2 or S3 storage is stored (Credentials)', href: '/vault' },
    { done: backups.length > 0 || restores.length > 0, label: 'A backup in that R2 / S3 bucket to restore from', href: '/backup' },
    { done: !!sys?.terraform.ok, label: 'terraform ready (auto-downloaded on first use)', href: '/settings' },
    { done: restores.length > 0, label: 'Run your first restore', href: '/restore/new' },
  ];
  const setupDone = steps.every((s) => s.done);

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Overview"
        title="Restore control"
        description="Put a zone back the way a backup has it: compare, review the plan, then apply with a Global API Key."
        actions={<Link href="/restore/new"><Button variant="primary" size="lg" icon={<RotateCcw className="size-4" />}>New restore</Button></Link>}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Last applied" value={stats.lastApplied ? relTime(stats.lastApplied.appliedAt ?? stats.lastApplied.createdAt) : '—'} sub={stats.lastApplied ? stats.lastApplied.zone.name : 'No restore applied yet'} tone={stats.lastApplied ? undefined : 'warn'} />
        <Stat label="Success rate" value={stats.rate === null ? '—' : `${stats.rate}%`} sub={`of ${stats.ended} applied or failed`} tone={stats.rate === null ? undefined : stats.rate >= 90 ? 'ok' : stats.rate >= 60 ? 'warn' : 'bad'} />
        <Stat label="Verified" value={stats.applied ? `${stats.verified}/${stats.applied}` : '—'} sub="matched the backup after applying" tone={stats.applied && stats.verified < stats.applied ? 'warn' : undefined} />
        <Stat label="Last 30 days" value={stats.month} sub={history ? `${history.planned30} planned · ${stats.zones} zone${stats.zones === 1 ? '' : 's'} restored in all` : ' '} />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          {(activeRestore || latest) && (() => {
            const live = !!activeRestore;
            const id = activeRestore?.id ?? latest!.id;
            return (
              <Card className="overflow-hidden">
                <div className="grid-bg flex flex-wrap items-center justify-between gap-4 px-6 py-5">
                  <div className="flex items-center gap-4">
                    <div className={cx('grid size-11 place-items-center rounded-xl border',
                      live ? 'border-live/30 bg-live/10 text-live' : isApplied(latest!) ? 'border-ok/25 bg-ok/10 text-ok' : isFailed(latest!) ? 'border-bad/25 bg-bad/10 text-bad' : 'border-line-strong bg-raised text-muted')}>
                      <RotateCcw className="size-5" />
                    </div>
                    <div>
                      <div className="eyebrow">{live ? 'Running now' : 'Latest restore'}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2.5">
                        <span className="text-[15px] font-semibold">{live ? activeRestore!.zone : latest!.zone.name}</span>
                        {live ? <Badge tone="signal"><span className="live-dot size-1.5 rounded-full bg-live" />{activeRestore!.job}</Badge> : <OutcomeBadge outcome={latest!.outcome} />}
                      </div>
                      <div className="mt-0.5 text-xs text-muted">
                        {live ? `by ${activeRestore!.by} · ${relTime(activeRestore!.since)}` : `${relTime(latest!.createdAt)} · ${latest!.createdBy}${latest!.source.folder ? ` · ${latest!.source.folder}` : ''}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {(live || latest?.outcome === 'open') && <Link href="/restore/new"><Button variant="primary" icon={<ArrowRight className="size-4" />}>{live ? 'Watch live' : 'Continue'}</Button></Link>}
                    <Link href={`/restore/history/${id}`}><Button icon={<ArrowRight className="size-4" />}>Open</Button></Link>
                  </div>
                </div>
              </Card>
            );
          })()}

          <Activity restores={restores} />

          <Card>
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="text-[15px] font-semibold">Recent restores</h2>
              <Link href="/restore/history" className="text-[13px] text-muted hover:text-ink">View all →</Link>
            </div>
            {loaded && !restores.length ? (
              <EmptyState icon={<RotateCcw className="size-5" />} title="No restores yet" description="Every restore appears here: the backup it used, what it changed and how it ended."
                action={<Link href="/restore/new"><Button variant="primary">Start a restore</Button></Link>} />
            ) : (
              <RestoreTable restores={restores.slice(0, 6)} />
            )}
          </Card>
        </div>

        <div className="space-y-6">
          {!setupDone && loaded && (
            <Card>
              <div className="border-b border-line px-5 py-4">
                <h2 className="text-[15px] font-semibold">Get set up</h2>
                <p className="mt-0.5 text-xs text-muted">{steps.filter((s) => s.done).length} of {steps.length} complete</p>
              </div>
              <ol className="space-y-1 p-3">
                {steps.map((s) => (
                  <li key={s.label}>
                    <Link href={s.href} className="flex items-start gap-3 rounded-lg px-2 py-2 text-[13px] hover:bg-raised">
                      {s.done ? <CheckCircle2 className="mt-px size-4 shrink-0 text-ok" /> : <Circle className="mt-px size-4 shrink-0 text-faint" />}
                      <span className={s.done ? 'text-muted line-through decoration-faint' : 'text-ink-2'}>{s.label}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            </Card>
          )}

          <Card>
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="text-[15px] font-semibold">Recent backups</h2>
              <DatabaseBackup className="size-4 text-faint" />
            </div>
            {!backups.length ? (
              <p className="px-5 py-5 text-[13px] text-muted">No successful backup run in the console yet. A restore can also use backups already in the account&apos;s R2 / S3 bucket; <Link href="/backup" className="text-signal hover:underline">run a backup</Link> to add one.</p>
            ) : (
              <ul className="p-2">
                {backups.slice(0, 5).map((r) => (
                  <li key={r.id}>
                    <Link href={`/runs/${r.id}`} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-raised/60">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-medium">{r.presetName ?? r.summary.account ?? r.credentialNames.cloudflare}</div>
                        <div className="text-xs text-muted" title={fmtDate(r.endedAt ?? r.startedAt)}>
                          {relTime(r.endedAt ?? r.startedAt)}{r.summary.zonesDone !== undefined ? ` · ${r.summary.zonesDone} zone${r.summary.zonesDone === 1 ? '' : 's'}` : ''}{r.config.r2.enabled ? ' · R2' : ''}{r.config.aws.enabled ? ' · S3' : ''}
                        </div>
                      </div>
                      <ArrowRight className="size-4 text-faint" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-line px-5 py-3 text-xs text-muted">A restore uses the newest backup of the zone in the account&apos;s R2 / S3 bucket.</p>
          </Card>

          <Link href="/restore/history" className="panel flex items-center gap-3 px-5 py-4 transition-colors hover:border-line-strong">
            <History className="size-4 text-muted" aria-hidden />
            <span className="flex-1 text-[13px] text-ink-2">
              Restore history
              <span className="block text-xs text-muted">{restores.length} restore{restores.length === 1 ? '' : 's'}, each with its plan, steps and log</span>
            </span>
            <ArrowRight className="size-4 text-faint" aria-hidden />
          </Link>
        </div>
      </div>
    </div>
  );
}
