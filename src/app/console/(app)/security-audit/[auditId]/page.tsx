'use client';

import { use, useEffect } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, FileJson, RefreshCw } from 'lucide-react';
import { fmtDate } from '@/lib/client';
import { windowLabel, type AuditView } from '@/lib/zone-audit/types';
import { Alert, Button, ButtonLink, Loading, PageHeader, SkeletonTable } from '@/components/ui';
import { useSnapshot } from '../../monitoring/use-run';
import { AuditState, Coverage, EffectivenessTable, Findings, Method, RecommendedActions, Summary } from '../audit-view';

interface View { audit: AuditView & { hours: number; error: string | null }; generatedAt: string }

/** Asked again every 3 seconds only while the audit runs; once it is finished, only Refresh reads it. */
const POLL_MS = 3_000;

export default function AuditPage({ params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = use(params);
  const { data, error, loading, reload } = useSnapshot<View>(`/api/security-audit/${encodeURIComponent(auditId)}`);
  const a = data?.audit;
  const r = a?.report;
  const runningNow = a?.status === 'running';
  useEffect(() => {
    if (!runningNow) return;
    const t = setTimeout(() => { void reload(); }, POLL_MS);
    return () => clearTimeout(t);
  }, [runningNow, reload, data]);
  const dl = (q: string) => `/api/security-audit/${encodeURIComponent(auditId)}/download?${q}`;
  return (
    <div className="space-y-6">
      <Link href="/console/security-audit" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-3.5" />Security audit</Link>
      <PageHeader eyebrow="Security audit" title={a?.zoneName || a?.zoneId || 'Audit'}
        description={a ? <>Started {fmtDate(a.startedAt)}{a.startedBy ? ` by ${a.startedBy}` : ''} · traffic window {windowLabel(r?.effectiveness?.hours || a.hours)}{r?.zone.plan ? ` · ${r.zone.plan} plan` : ''}{r ? ` · ${r.summary.coverage.passed + r.summary.coverage.finding} of ${r.summary.rules} checks read` : ''}</> : undefined}
        actions={<>
          <Button variant="ghost" loading={loading && !!data} onClick={reload} icon={<RefreshCw className="size-4" />}>Refresh</Button>
          {r && <>
            <ButtonLink href={dl('format=md')} download icon={<Download className="size-4" />}>REPORT.md</ButtonLink>
            <ButtonLink href={dl('format=json')} download icon={<FileJson className="size-4" />}>findings.json</ButtonLink>
            <ButtonLink href={dl('format=csv&part=findings')} download icon={<Download className="size-4" />}>CSV</ButtonLink>
          </>}
        </>} />
      {error && <Alert tone="bad" title="The audit could not be read">{error}</Alert>}
      {!data && !error && <Loading label="Loading the audit"><SkeletonTable rows={6} cols={4} /></Loading>}
      {a && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
          <AuditState status={a.status} />
          {a.finishedAt && <span>Finished {fmtDate(a.finishedAt)}</span>}
          {data && <span>As of {fmtDate(data.generatedAt)}</span>}
        </div>
      )}
      {a && runningNow && <Alert tone="info" title="Reading the zone">The audit runs on the worker; this page looks again every few seconds until it is done.</Alert>}
      {a && a.status === 'failed' && <Alert tone="bad" title="The audit did not finish">{a.error ?? 'Unknown error'}</Alert>}
      {r && (
        <>
          <p className="text-[13px] text-muted">Read-only: nothing was changed in Cloudflare. <strong className="font-medium text-ink-2">Confirmed</strong> means the zone&apos;s configuration (or the traffic numbers) proves the outcome; <strong className="font-medium text-ink-2">Needs validation</strong> means it depends on something they cannot show, and the finding says how to check.</p>
          <Summary r={r} />
          <RecommendedActions e={r.effectiveness} />
          <Findings r={r} section="managed" />
          <Findings r={r} section="config" />
          <EffectivenessTable e={r.effectiveness} note={r.reads.find((x) => x.key === 'events')?.reason} />
          <Findings r={r} section="traffic" />
          <div className="flex flex-wrap gap-2">
            <ButtonLink size="sm" variant="ghost" href={dl('format=csv&part=effectiveness')} download icon={<Download className="size-3.5" />}>Rule effectiveness CSV</ButtonLink>
            <ButtonLink size="sm" variant="ghost" href={dl('format=csv&part=coverage')} download icon={<Download className="size-3.5" />}>Coverage CSV</ButtonLink>
          </div>
          <Coverage r={r} />
          <Method r={r} />
        </>
      )}
    </div>
  );
}
