'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Copy, FileWarning, FolderOpen, RotateCcw, Square, Trash2 } from 'lucide-react';
import { api, copyText, duration, fmtDate } from '@/lib/client';
import { summarizeLines, type RunMeta } from '@/lib/run-types';
import { Button, Card, Loading, Modal, Skeleton, StatusBadge, cx } from '@/components/ui';
import { Terminal } from '@/components/terminal';
import { BackupFiles } from '@/components/backup-files';
import { useToast } from '@/components/toast';
import { useMe } from '@/components/me';

function Metric({ label, value, tone, pending }: { label: string; value: React.ReactNode; tone?: 'ok' | 'bad' | 'warn'; pending?: boolean }) {
  return (
    <div className="px-5 py-4">
      <div className="eyebrow">{label}</div>
      {pending ? <Skeleton className="mt-2.5 h-5 w-12" /> : <div className={cx('mt-1.5 text-xl font-semibold tabular-nums', tone === 'ok' && 'text-ok', tone === 'bad' && 'text-bad', tone === 'warn' && 'text-warn')}>{value}</div>}
    </div>
  );
}

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { can } = useMe();
  const [meta, setMeta] = useState<RunMeta | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [integrity, setIntegrity] = useState<string | null>(null);
  const [approval, setApproval] = useState<{ requestedBy: string; approvedBy: string; approvedAt: string } | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    api<{ run: RunMeta; approval: { requestedBy: string; approvedBy: string; approvedAt: string } | null }>(`/api/runs/${id}`).then((r) => { setMeta(r.run); setApproval(r.approval); }).catch(() => setNotFound(true));
    let es: EventSource | null = null;
    let done = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // A stream can end before the run does (on Vercel it is closed after a few minutes):
    // connect again; the backlog brings the log up to date.
    const connect = () => {
      es = new EventSource(`/api/runs/${id}/stream`);
      es.addEventListener('backlog', (e) => setLines(JSON.parse((e as MessageEvent).data)));
      es.addEventListener('line', (e) => setLines((ls) => [...ls, JSON.parse((e as MessageEvent).data)]));
      es.addEventListener('status', (e) => {
        const m = JSON.parse((e as MessageEvent).data) as RunMeta | null;
        if (m) setMeta(m);
        done = true;
        es?.close();
        api<{ run: RunMeta; integrity: string | null }>(`/api/runs/${id}`).then((r) => { setMeta(r.run); setIntegrity(r.integrity); }).catch(() => {});
      });
      es.onerror = () => { es?.close(); if (!done) retry = setTimeout(connect, 3_000); };
    };
    connect();
    return () => { done = true; clearTimeout(retry); es?.close(); };
  }, [id]);

  const running = meta?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  // Live numbers come from the streamed lines; the stored summary covers finished runs.
  const s = useMemo(() => (lines.length ? summarizeLines(lines) : meta?.summary), [lines, meta]);

  const cancel = async () => {
    try {
      await api(`/api/runs/${id}/cancel`, { method: 'POST' });
      toast('Cancelling backup…', 'info');
    } catch (e) { toast((e as Error).message, 'bad'); }
    setCancelOpen(false);
  };
  const remove = async () => {
    if (!confirm('Delete this run record and its log? The backup files on disk are kept.')) return;
    try { await api(`/api/runs/${id}`, { method: 'DELETE' }); router.push('/console/runs'); } catch (e) { toast((e as Error).message, 'bad'); }
  };

  if (notFound) {
    return (
      <div className="py-20 text-center">
        <h1 className="text-xl font-semibold">Run not found</h1>
        <Link href="/console/runs" className="mt-3 inline-block text-sm text-signal hover:underline">Back to history</Link>
      </div>
    );
  }

  const total = s?.zonesTotal ?? 0;
  const done = s?.zonesDone ?? 0;
  const pending = !meta && !lines.length;
  const pct = meta?.status === 'succeeded' ? 100 : total ? Math.min(99, Math.round((done / total) * 100)) : 0;

  return (
    <div className="rise">
      <Link href="/console/runs" className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-3.5" /> Run history</Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        {pending ? (
          <Loading label="Loading run" className="space-y-3 py-1"><Skeleton className="h-7 w-64" /><Skeleton className="h-3 w-96 max-w-full" /></Loading>
        ) : <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{meta?.presetName ?? s?.account ?? meta?.credentialNames.cloudflare ?? 'Backup run'}</h1>
            {meta && <StatusBadge status={meta.status} />}
          </div>
          <p className="mt-1.5 font-mono text-xs text-muted">
            {id} · started {fmtDate(meta?.startedAt)}{meta?.startedBy ? ` by ${meta.startedBy}` : ''}{meta ? ` · ${duration(meta.startedAt, meta.endedAt)}` : ''}
            {meta?.exitCode !== undefined && meta.exitCode !== null ? ` · exit ${meta.exitCode}` : ''}
          </p>
          {approval && <p className="mt-1 text-xs text-muted">Requested by {approval.requestedBy} · approved by <span className="text-ink-2">{approval.approvedBy}</span> {fmtDate(approval.approvedAt)}</p>}
        </div>}
        <div className="flex gap-2">
          {running ? (
            can('runs:cancel') && <Button variant="danger" icon={<Square className="size-3.5" />} onClick={() => setCancelOpen(true)}>Cancel run</Button>
          ) : (
            <>
              {can('runs:delete') && <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={remove}>Delete</Button>}
              {can('runs:start') && <Button icon={<RotateCcw className="size-4" />} onClick={() => router.push(`/console/backup?from=${id}`)}>Run again</Button>}
            </>
          )}
        </div>
      </div>

      <Card className="mb-6 overflow-hidden">
        <div className="h-1 w-full bg-line">
          <div
            className={cx('h-full transition-all duration-700',
              meta?.status === 'failed' ? 'bg-bad' : meta?.status === 'succeeded' ? 'bg-ok' : meta?.status === 'running' ? 'progress-live bg-live' : 'bg-muted')}
            style={{ width: `${running && !total ? 8 : pct}%` }}
          />
        </div>
        <div className="grid grid-cols-2 divide-line sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
          <Metric pending={pending} label="Zones" value={total ? `${done}/${total}` : '—'} />
          <Metric pending={pending} label="Warnings" value={s?.warnings ?? 0} tone={s?.warnings ? 'warn' : undefined} />
          <Metric pending={pending} label="Errors" value={s?.errors ?? 0} tone={s?.errors ? 'bad' : undefined} />
          <Metric pending={pending} label="API failures" value={s?.apiErrors ?? '—'} tone={s?.apiErrors ? 'warn' : s?.apiErrors === 0 ? 'ok' : undefined} />
          <Metric pending={pending} label="Quarantined HCL" value={s?.quarantined ?? '—'} tone={s?.quarantined ? 'warn' : s?.quarantined === 0 ? 'ok' : undefined} />
          <Metric pending={pending} label="Integrity" value={s?.gaps === undefined ? '—' : s.gaps ? 'Gaps' : 'Clean'} tone={s?.gaps === undefined ? undefined : s.gaps ? 'warn' : 'ok'} />
        </div>
        {s?.backupRoot && (
          <div className="flex items-center gap-3 border-t border-line px-5 py-3 text-[13px]">
            <FolderOpen className="size-4 shrink-0 text-faint" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">{s.backupRoot}</span>
            <button onClick={async () => { await copyText(s.backupRoot!); toast('Path copied'); }} className="rounded p-1 text-faint hover:text-ink" title="Copy path"><Copy className="size-3.5" /></button>
          </div>
        )}
      </Card>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <Terminal lines={lines} live={running} filename={`cf_backup_${id}.log`} />
          {meta && !running && s?.backupRoot && <BackupFiles runId={id} />}
        </div>
        <div className="space-y-4">
          <Card>
            <div className="border-b border-line px-5 py-3.5 text-sm font-semibold">Configuration</div>
            {!meta && (
              <Loading label="Loading run configuration" className="space-y-2.5 px-5 py-4">
                {[0, 1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="flex justify-between gap-3 py-0.5"><Skeleton className="h-3 w-20" /><Skeleton className="h-3 w-24" /></div>)}
              </Loading>
            )}
            <dl className={cx('space-y-2.5 px-5 py-4 text-[13px]', !meta && 'hidden')}>
              {meta && ([
                ['Source', meta.credentialNames.cloudflare ?? '—'],
                ['Zones', meta.config.zoneMode === 'all' ? 'All zones' : `${meta.config.zoneIds.length} selected`],
                ['Mode', meta.config.importMode ? 'Generate + import' : 'Generate only'],
                ['Account policy', meta.config.accountScope + (meta.config.withAccount ? ' · --with-account' : '')],
                ['Audit logs', `${meta.config.auditLogHours}h`],
                ['R2 upload', meta.config.r2.enabled ? [meta.config.r2.bucket, meta.credentialNames.r2].filter(Boolean).join(' · ') || 'on' : 'off'],
                ['S3 upload', meta.config.aws.enabled ? [meta.config.aws.bucket, meta.credentialNames.aws].filter(Boolean).join(' · ') || 'on' : 'off'],
              ] as const).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="text-right text-ink-2">{v}</dd></div>
              ))}
            </dl>
            {meta && (
              <div className="border-t border-line px-5 py-4">
                <div className="eyebrow mb-2">Executed</div>
                <pre className="max-h-56 overflow-auto rounded-lg border border-line bg-canvas p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-muted">{meta.command}</pre>
              </div>
            )}
          </Card>
          {integrity && (
            <Card>
              <div className="flex items-center gap-2 border-b border-line px-5 py-3.5 text-sm font-semibold"><FileWarning className="size-4 text-muted" /> _backup_summary.txt</div>
              <pre className="max-h-80 overflow-auto px-5 py-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">{integrity}</pre>
            </Card>
          )}
        </div>
      </div>

      <Modal
        open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel this backup?"
        description="The process tree (node, terraform, cf-terraforming) is terminated."
        footer={<><Button variant="ghost" onClick={() => setCancelOpen(false)}>Keep running</Button><Button variant="danger" onClick={cancel}>Cancel run</Button></>}
      >
        <p className="text-sm text-muted">Files written so far stay on disk but form an <span className="text-warn">incomplete</span> backup. If an R2 upload was in progress, check the bucket lock state afterwards.</p>
      </Modal>
    </div>
  );
}
