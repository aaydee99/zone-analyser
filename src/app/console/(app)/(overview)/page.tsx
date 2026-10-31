'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Bookmark, CheckCircle2, Circle, DatabaseBackup, KeyRound, Play, Wrench } from 'lucide-react';
import { api, relTime } from '@/lib/client';
import type { CredentialOption } from '@/lib/kinds';
import { useMe } from '@/components/me';
import type { RunMeta } from '@/lib/run-types';
import type { BackupConfig } from '@/lib/config';
import { ButtonLink, Card, EmptyState, Loading, PageHeader, Skeleton, SkeletonStats, SkeletonTable, Stat, StatusBadge, cx } from '@/components/ui';
import { RunTable } from '@/components/run-table';
import { QuickZones } from '@/components/quick-zones';
import { HealthCard } from '@/components/health-card';

interface Preset { id: string; name: string; config: BackupConfig; updatedAt: string }
interface Check { ok: boolean; detail: string }
interface SystemCheck { node: Check; terraform: Check; cfTerraforming: Check; script: Check; envOverride: Check }

export default function Overview() {
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [creds, setCreds] = useState<CredentialOption[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [sys, setSys] = useState<SystemCheck | null>(null);
  const [loaded, setLoaded] = useState(false);

  const { can } = useMe();
  const canRun = can('runs:start');
  useEffect(() => {
    Promise.all([
      api<{ runs: RunMeta[] }>('/api/runs').then((r) => setRuns(r.runs)),
      canRun ? api<{ options: CredentialOption[] }>('/api/credentials/options').then((r) => setCreds(r.options)) : null,
      api<{ presets: Preset[] }>('/api/presets').then((r) => setPresets(r.presets)),
      api<{ check: SystemCheck }>('/api/system').then((r) => setSys(r.check)),
    ]).catch(() => {}).finally(() => setLoaded(true));
  }, [canRun]);

  const stats = useMemo(() => {
    const finished = runs.filter((r) => r.status !== 'running');
    const ok = finished.filter((r) => r.status === 'succeeded');
    const lastOk = ok[0];
    const week = runs.filter((r) => Date.now() - Date.parse(r.startedAt) < 7 * 86400_000);
    return {
      rate: finished.length ? Math.round((ok.length / finished.length) * 100) : null,
      lastOk,
      week: week.length,
      clean: ok.filter((r) => r.summary.gaps === false).length,
      okCount: ok.length,
    };
  }, [runs]);

  const hasCf = creds.some((c) => c.kind === 'cloudflare');
  const cfVerified = creds.some((c) => c.kind === 'cloudflare' && c.tested);
  const toolsOk = !!sys && sys.terraform.ok && sys.cfTerraforming.ok && sys.script.ok && sys.envOverride.ok;
  const vault = can('vault:access');
  const steps = [
    { done: hasCf, label: vault ? 'Add the Cloudflare API token to back up with' : 'A super admin adds a Cloudflare token', href: vault ? '/console/vault' : '/' },
    { done: cfVerified, label: vault ? 'Test the token against the Cloudflare API' : 'A super admin verifies the token', href: vault ? '/console/vault' : '/' },
    { done: toolsOk, label: 'Tools ready (auto-downloaded on the first backup)', href: '/console/settings' },
    { done: runs.length > 0, label: 'Run your first backup', href: '/console/backup' },
  ];
  // Viewers cannot act on any of these steps.
  const setupDone = !canRun || steps.every((s) => s.done);
  const latest = runs[0];

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Overview"
        title="Backup control"
        description="Cloudflare configuration exported to Terraform and JSON, with offsite copies to R2 or S3."
        actions={canRun && <ButtonLink href="/console/backup" variant="primary" size="lg" icon={<Play className="size-4" />}>New backup</ButtonLink>}
      />

      {!loaded ? (
        <Loading label="Loading backup stats" className="mb-6"><SkeletonStats className="!grid-cols-1 !gap-4 sm:!grid-cols-2 lg:!grid-cols-4" /></Loading>
      ) : <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Last successful" value={stats.lastOk ? relTime(stats.lastOk.endedAt ?? stats.lastOk.startedAt) : '—'} sub={stats.lastOk ? stats.lastOk.summary.account ?? stats.lastOk.credentialNames.cloudflare : 'No successful run yet'} tone={stats.lastOk ? undefined : 'warn'} />
        <Stat label="Success rate" value={stats.rate === null ? '—' : `${stats.rate}%`} sub={`${runs.length} run${runs.length === 1 ? '' : 's'} total`} tone={stats.rate === null ? undefined : stats.rate >= 90 ? 'ok' : stats.rate >= 60 ? 'warn' : 'bad'} />
        <Stat label="Clean backups" value={stats.clean} sub={`of ${stats.okCount} successful — no integrity gaps`} />
        <Stat label="Zones in last backup" value={stats.lastOk?.summary.zonesDone ?? '—'} sub={stats.lastOk ? `${stats.week} run${stats.week === 1 ? '' : 's'} in the last 7 days` : 'Run a backup to see coverage'} />
      </div>}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          {latest && (
            <Card className="overflow-hidden">
              <div className="grid-bg flex flex-wrap items-center justify-between gap-4 px-6 py-5">
                <div className="flex items-center gap-4">
                  <div className={cx('grid size-11 place-items-center rounded-xl border',
                    latest.status === 'running' ? 'border-live/30 bg-live/10 text-live' : latest.status === 'succeeded' ? 'border-ok/25 bg-ok/10 text-ok' : 'border-bad/25 bg-bad/10 text-bad')}>
                    <DatabaseBackup className="size-5" />
                  </div>
                  <div>
                    <div className="eyebrow">Latest run</div>
                    <div className="mt-0.5 flex items-center gap-2.5">
                      <span className="text-[15px] font-semibold">{latest.presetName ?? latest.summary.account ?? latest.credentialNames.cloudflare}</span>
                      <StatusBadge status={latest.status} />
                    </div>
                    <div className="mt-0.5 text-xs text-muted">{relTime(latest.startedAt)}{latest.summary.zonesTotal ? ` · ${latest.summary.zonesDone ?? 0}/${latest.summary.zonesTotal} zones` : ''}</div>
                  </div>
                </div>
                <ButtonLink href={`/console/runs/${latest.id}`} icon={<ArrowRight className="size-4" />}>{latest.status === 'running' ? 'Watch live' : 'Open'}</ButtonLink>
              </div>
            </Card>
          )}

          <Card>
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="text-[15px] font-semibold">Recent runs</h2>
              <Link href="/console/runs" className="text-[13px] text-muted hover:text-ink">View all →</Link>
            </div>
            {!loaded ? (
              <Loading label="Loading recent runs"><SkeletonTable rows={6} cols={6} className="!rounded-none !border-0" /></Loading>
            ) : runs.length === 0 ? (
              <EmptyState icon={<DatabaseBackup className="size-5" />} title="No backups yet" description={canRun ? 'Configure a run — every flag of backup.js is a switch.' : 'Runs appear here once an operator starts a backup.'} action={canRun ? <ButtonLink href="/console/backup" variant="primary">Configure a backup</ButtonLink> : undefined} />
            ) : (
              <RunTable runs={runs.slice(0, 6)} />
            )}
          </Card>

          <QuickZones />
        </div>

        <div className="space-y-6">
          <HealthCard />
          {canRun && !loaded && (
            <Card>
              <Loading label="Loading setup checklist">
                <div className="space-y-2 border-b border-line px-5 py-4"><Skeleton className="h-4 w-24" /><Skeleton className="h-3 w-28" /></div>
                <div className="space-y-1 p-3">
                  {[72, 64, 80, 52].map((w) => (
                    <div key={w} className="flex items-center gap-3 px-2 py-2"><Skeleton className="size-4 shrink-0 rounded-full" /><Skeleton className="h-3" style={{ width: `${w}%` }} /></div>
                  ))}
                </div>
              </Loading>
            </Card>
          )}
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
              <h2 className="text-[15px] font-semibold">Presets</h2>
              <Bookmark className="size-4 text-faint" />
            </div>
            {!loaded ? (
              <Loading label="Loading presets" className="space-y-1 p-2">
                {[0, 1].map((i) => <div key={i} className="space-y-2 px-3 py-2.5"><Skeleton className="h-3.5 w-36" /><Skeleton className="h-3 w-24" /></div>)}
              </Loading>
            ) : presets.length === 0 ? (
              <p className="px-5 py-5 text-[13px] text-muted">
                {canRun
                  ? <>Save a configuration from <Link href="/console/backup" className="text-signal hover:underline">New backup</Link> to launch it in one click.</>
                  : 'No presets yet. Operators and admins save them when they configure a backup.'}
              </p>
            ) : (
              <ul className="p-2">
                {presets.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-raised/60">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium">{p.name}</div>
                      <div className="text-xs text-muted">
                        {p.config.zoneMode === 'all' ? 'All zones' : `${p.config.zoneIds.length} zones`}
                        {p.config.importMode ? ' · import' : ''}{p.config.r2.enabled ? ' · R2' : ''}{p.config.aws.enabled ? ' · S3' : ''}
                      </div>
                    </div>
                    {canRun && <ButtonLink href={`/console/backup?preset=${p.id}`} size="sm" icon={<Play className="size-3" />}>Open</ButtonLink>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="text-[15px] font-semibold">Environment</h2>
              <Link href="/console/settings" className="text-faint hover:text-ink"><Wrench className="size-4" /></Link>
            </div>
            {!sys && !loaded ? (
              <Loading label="Checking the environment" className="space-y-2.5 px-5 py-4">
                {[0, 1, 2, 3].map((i) => <div key={i} className="flex items-center justify-between gap-3 py-0.5"><Skeleton className="h-3 w-24" /><Skeleton className="h-3 w-20" /></div>)}
              </Loading>
            ) : <ul className="space-y-2.5 px-5 py-4 text-[13px]">
              {sys ? ([['Node.js', sys.node], ['terraform', sys.terraform], ['cf-terraforming', sys.cfTerraforming], ['backup.js', sys.script]] as const).map(([k, v]) => (
                <li key={k} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-ink-2"><span className={cx('size-1.5 rounded-full', v.ok ? 'bg-ok' : 'bg-bad')} />{k}</span>
                  <span className={cx('max-w-[170px] truncate font-mono text-[11.5px]', v.ok ? 'text-muted' : 'text-bad')} title={v.detail}>{k === 'backup.js' ? (v.ok ? 'present' : 'missing') : v.detail}</span>
                </li>
              )) : <li className="text-muted">Checking…</li>}
            </ul>}
          </Card>

          {canRun && (
            <Link href={vault ? '/console/vault' : '/console/backup'} className="panel flex items-center gap-3 px-5 py-4 transition-colors hover:border-line-strong">
              <KeyRound className="size-4 text-muted" aria-hidden />
              <span className="flex-1 text-[13px] text-ink-2">
                Credentials{!vault && <span className="ml-1.5 text-[11px] text-faint">· managed by super admins</span>}
                {!loaded ? <Skeleton className="mt-1 h-3 w-48" /> : <span className="block text-xs text-muted">
                  {creds.filter((c) => c.kind === 'cloudflare').length} Cloudflare · {creds.filter((c) => c.kind !== 'cloudflare').length} storage, available to backups
                </span>}
              </span>
              <ArrowRight className="size-4 text-faint" aria-hidden />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
