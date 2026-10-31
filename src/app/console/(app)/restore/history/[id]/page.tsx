'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, CheckCircle2, CircleDot, RotateCcw, XCircle } from 'lucide-react';
import { api, duration, fmtDate } from '@/lib/client';
import type { RestoreOutcome, RestoreRecord } from '@/lib/restore-history';
import { OutcomeBadge } from '@/components/restore-table';
import { Terminal } from '@/components/terminal';
import { Badge, ButtonLink, Card, Loading, Skeleton, cx } from '@/components/ui';

type Detail = RestoreRecord & { outcome: RestoreOutcome; live: boolean };

function Metric({ label, value, tone, pending }: { label: string; value: React.ReactNode; tone?: 'ok' | 'bad' | 'warn'; pending?: boolean }) {
  return (
    <div className="px-5 py-4">
      <div className="eyebrow">{label}</div>
      {pending ? <Skeleton className="mt-2.5 h-5 w-16" /> : <div className={cx('mt-1.5 text-xl font-semibold tabular-nums', tone === 'ok' && 'text-ok', tone === 'bad' && 'text-bad', tone === 'warn' && 'text-warn')}>{value}</div>}
    </div>
  );
}

const ACTION: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  create: { label: 'create', tone: 'ok' },
  update: { label: 'update', tone: 'info' },
  delete: { label: 'delete', tone: 'bad' },
  'delete+create': { label: 'replace', tone: 'warn' },
  'create+delete': { label: 'replace', tone: 'warn' },
  'no-op': { label: 'no change', tone: 'neutral' },
  restore: { label: 'restored', tone: 'info' },
};

export default function RestoreDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [r, setR] = useState<Detail | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = () => api<Detail>(`/api/restore/history/${encodeURIComponent(id)}`).then((d) => { if (!stop) setR(d); }).catch(() => { if (!stop) setNotFound(true); });
    load();
    const t = setInterval(() => { if (r?.outcome === 'running' || !r) load(); }, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [id, r?.outcome]); // eslint-disable-line react-hooks/exhaustive-deps

  if (notFound) {
    return (
      <div className="py-20 text-center">
        <h1 className="text-xl font-semibold">Restore not found</h1>
        <Link href="/console/restore/history" className="mt-3 inline-block text-sm text-signal hover:underline">Back to restore history</Link>
      </div>
    );
  }

  const changes = (r?.plan?.changes ?? []).filter((c) => !c.actions.includes('no-op'));
  const running = r?.outcome === 'running';
  const ended = r?.appliedAt ?? (r && !running ? r.updatedAt : null);

  return (
    <div className="rise">
      <Link href="/console/restore/history" className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-3.5" /> Restore history</Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        {!r ? (
          <Loading label="Loading restore" className="space-y-3 py-1"><Skeleton className="h-7 w-56" /><Skeleton className="h-3 w-96 max-w-full" /></Loading>
        ) : <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{r?.zone.name || 'Restore'}</h1>
            {r && <OutcomeBadge outcome={r.outcome} />}
          </div>
          <p className="mt-1.5 font-mono text-xs text-muted">
            {r?.legacy ? 'from the audit log' : id} · started {fmtDate(r?.createdAt)}{r?.createdBy ? ` by ${r.createdBy}` : ''}{r && ended ? ` · ${duration(r.createdAt, ended)}` : ''}
          </p>
        </div>}
        <div className="flex gap-2">
          {r?.live && (r.outcome === 'running' || r.outcome === 'open') && (
            <ButtonLink href="/console/restore/new" variant="primary" icon={<ArrowRight className="size-4" />}>{running ? 'Watch live' : 'Continue in New restore'}</ButtonLink>
          )}
          <ButtonLink href="/console/restore/new" icon={<RotateCcw className="size-4" />}>New restore</ButtonLink>
        </div>
      </div>

      <Card className="mb-6 overflow-hidden">
        <div className="h-1 w-full bg-line">
          <div className={cx('h-full transition-all duration-700',
            r?.outcome === 'applied' || r?.outcome === 'matched' ? 'bg-ok' : r?.outcome === 'applied-unverified' || r?.outcome === 'interrupted' ? 'bg-warn' : r?.outcome === 'failed' || r?.outcome === 'plan-failed' ? 'bg-bad' : running ? 'progress-live bg-live' : 'bg-muted')}
            style={{ width: `${r?.appliedAt || r?.outcome === 'failed' ? 100 : r?.plan ? 66 : r ? 33 : 0}%` }} />
        </div>
        <div className="grid grid-cols-2 divide-line sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
          <Metric pending={!r} label="Audit-log changes" value={r?.legacy ? '—' : r?.auditChanges ?? '—'} />
          <Metric pending={!r} label="Mode" value={r?.scan ? 'Everything' : r?.legacy ? '—' : 'Changes'} />
          <Metric pending={!r} label="Planned changes" value={r?.plan ? changes.length : '—'} />
          <Metric pending={!r} label="Applied" value={r?.appliedAt ? fmtDate(r.appliedAt) : '—'} tone={r?.appliedAt ? 'ok' : r?.outcome === 'failed' ? 'bad' : undefined} />
          <Metric pending={!r} label="Verified" value={r?.verified === null || r?.verified === undefined ? '—' : r.verified ? 'Matches backup' : 'Differences'} tone={r?.verified === true ? 'ok' : r?.verified === false ? 'warn' : undefined} />
        </div>
      </Card>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          {r && !r.legacy && <Terminal lines={r.log} live={running} filename={`restore_${r.zone.name}_${id}.log`} />}
          <Card>
            <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <span className="text-sm font-semibold">{r?.appliedAt ? 'Applied plan' : 'Reviewed plan'}</span>
              {r?.plan && <span className="text-xs text-muted">{fmtDate(r.plan.at)}{r.plan.hasDelete ? ' · has deletions' : ''}{r.plan.hasReplace ? ' · has replacements' : ''}</span>}
            </div>
            {!r ? (
              <Loading label="Loading the plan" className="divide-y divide-line/60">
                {[60, 48, 70].map((w) => <div key={w} className="flex items-center gap-3 px-5 py-3"><Skeleton className="h-5 w-14" /><Skeleton className="h-3" style={{ width: `${w}%` }} /></div>)}
              </Loading>
            ) : !r.plan ? <p className="px-5 py-4 text-[13px] text-muted">No plan was made for this restore.</p>
              : !changes.length ? <p className="px-5 py-4 text-[13px] text-muted">The plan had no changes: the zone already matched the backup.</p> : (
                <ul className="divide-y divide-line/60">
                  {changes.map((c) => {
                    const a = ACTION[c.actions.join('+')] ?? { label: c.actions.join('+'), tone: 'neutral' as const };
                    return (
                      <li key={c.address} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                        <Badge tone={a.tone}>{a.label}</Badge>
                        <span className="min-w-0 flex-1 font-mono text-[12px] break-all text-ink-2">{c.address}</span>
                        {c.api && <span className="text-[11px] text-faint">through the API</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <div className="border-b border-line px-5 py-3.5 text-sm font-semibold">Steps</div>
            {!r && (
              <Loading label="Loading steps" className="space-y-3 px-5 py-4">
                {[0, 1, 2].map((i) => <div key={i} className="flex gap-3"><Skeleton className="size-4 shrink-0 rounded-full" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3 w-3/4" /><Skeleton className="h-3 w-1/2" /></div></div>)}
              </Loading>
            )}
            <ol className={cx('space-y-3 px-5 py-4 text-[13px]', !r && 'hidden')}>
              {(r?.steps ?? []).map((s, i) => {
                const bad = /failed/i.test(s.step);
                const good = /^Applied/.test(s.step);
                const Icon = bad ? XCircle : good ? CheckCircle2 : CircleDot;
                return (
                  <li key={i} className="flex gap-3">
                    <Icon className={cx('mt-0.5 size-4 shrink-0', bad ? 'text-bad' : good ? 'text-ok' : 'text-faint')} />
                    <span className="min-w-0">
                      <span className="text-ink-2">{s.step}</span>
                      <span className="block text-xs text-muted">{fmtDate(s.at)}{s.by ? ` · ${s.by}` : ''}</span>
                    </span>
                  </li>
                );
              })}
              {r && !r.steps.length && <li className="text-muted">No steps recorded.</li>}
            </ol>
          </Card>
          <Card>
            <div className="border-b border-line px-5 py-3.5 text-sm font-semibold">Backup</div>
            {!r && (
              <Loading label="Loading backup details" className="space-y-2.5 px-5 py-4">
                {[0, 1, 2, 3, 4].map((i) => <div key={i} className="flex justify-between gap-3 py-0.5"><Skeleton className="h-3 w-16" /><Skeleton className="h-3 w-28" /></div>)}
              </Loading>
            )}
            <dl className={cx('space-y-2.5 px-5 py-4 text-[13px]', !r && 'hidden')}>
              {r && ([
                ['Folder', r.source.folder || '—'],
                ['Taken', r.source.backupTime ? fmtDate(r.source.backupTime) : '—'],
                ['Storage', r.source.kind ? `${r.source.kind === 'r2' ? 'R2' : 'S3'} · ${r.source.bucket}` : '—'],
                ['Account', r.account.credentialName || '—'],
                ['Applied by', r.appliedBy || '—'],
              ] as const).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3"><dt className="shrink-0 text-muted">{k}</dt><dd className="min-w-0 text-right break-all text-ink-2">{v}</dd></div>
              ))}
            </dl>
            {r?.scan && (
              <div className="border-t border-line px-5 py-4 text-[13px]">
                <div className="eyebrow mb-2">Compare everything</div>
                <p className="text-ink-2">{r.scan.total} resources: {r.scan.differs} differ, {r.scan.missing} deleted, {r.scan.extra} not in the backup, {r.scan.matches} match{r.scan.unchecked ? `, ${r.scan.unchecked} could not be checked` : ''}.</p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
