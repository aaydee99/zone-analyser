'use client';

import { use, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, RefreshCw } from 'lucide-react';
import { fmtDate } from '@/lib/client';
import { SEVERITIES } from '@/lib/monitor-types';
import { periodLabel, sectionLines } from '@/lib/report-render';
import { SECTION_LABEL, bytesLabel, changeLabel, sumCounts, type ReportContent, type ReportDefinition, type ReportRun, type SectionKey, type TrafficNumbers } from '@/lib/report-types';
import { Alert, Badge, ButtonLink, Button, Card, Loading, PageHeader, SectionHeader, SkeletonTable, Stat } from '@/components/ui';
import { SeverityBadge } from '@/components/monitor-view';
import { useSnapshot } from '../../../monitoring/use-run';
import { RunState } from '../../run-state';

interface RunView { run: ReportRun; definition: ReportDefinition | null; generatedAt: string }

const whole = new Intl.NumberFormat();
const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

function Table({ head, rows, empty = 'Nothing.' }: { head: string[]; rows: ReactNode[][]; empty?: string }) {
  if (!rows.length) return <p className="px-5 py-3 text-[13px] text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-[13px]">
        <thead className="border-b border-line text-xs text-muted"><tr>{head.map((h) => <th key={h} scope="col" className="px-5 py-2 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-line/70">{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-5 py-2 align-top text-ink-2">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Section({ c, k, runId, children }: { c: ReportContent; k: SectionKey; runId: string; children?: ReactNode }) {
  const s = c.sections[k] as { status: string; note?: string } | undefined;
  if (!s) return null;
  return (
    <Card>
      <SectionHeader title={SECTION_LABEL[k]} aside={<ButtonLink size="sm" variant="ghost" href={`/api/reports/runs/${runId}/download?format=csv&section=${k}`} download icon={<Download className="size-3.5" />}>CSV</ButtonLink>} />
      <div className="px-5 pt-3">
        {s.status === 'unavailable' ? <Alert tone="warn" title="Not available">{s.note ?? 'Could not be read'}</Alert>
          : <ul className="space-y-0.5 text-[13px] text-ink-2">{sectionLines(c, k).map((l) => <li key={l}>{l}</li>)}</ul>}
        {s.status !== 'unavailable' && s.note && <p className="mt-1 text-xs text-muted">{s.note}</p>}
      </div>
      <div className="pb-2 pt-3">{s.status !== 'unavailable' && children}</div>
    </Card>
  );
}

const trafficRow = (label: string, t: TrafficNumbers | null, before: TrafficNumbers | null) => [
  label, t ? whole.format(t.requests) : '—', t ? `${t.requests ? ((t.cachedRequests / t.requests) * 100).toFixed(1) : '0.0'}%` : '—', t ? bytesLabel(t.bytes) : '—', t ? whole.format(t.pageViews) : '—',
  t && before ? changeLabel(t.requests, before.requests) : '',
];

export default function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const { data, error, loading, reload } = useSnapshot<RunView>(`/api/reports/runs/${encodeURIComponent(runId)}`);
  const run = data?.run;
  const c = run?.content;
  const s = c?.sections;
  return (
    <div className="space-y-6">
      <Link href={run ? `/console/reports/${run.definitionId}` : '/console/reports'} className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-3.5" />{data?.definition?.name ?? 'Reports'}</Link>
      <PageHeader eyebrow="Report" title={c?.name ?? 'Report'} description={c ? `${c.scope.label} · ${periodLabel(c)}` : undefined}
        actions={<>
          <Button variant="ghost" loading={loading && !!data} onClick={reload} icon={<RefreshCw className="size-4" />}>Refresh</Button>
          {c && <ButtonLink href={`/api/reports/runs/${runId}/download?format=html`} download icon={<Download className="size-4" />}>Download HTML</ButtonLink>}
        </>} />
      {error && <Alert tone="bad" title="The report could not be read">{error}</Alert>}
      {!data && !error && <Loading label="Loading the report"><SkeletonTable rows={6} cols={4} /></Loading>}
      {run && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-muted">
          <RunState run={run} />
          <span>{run.trigger === 'manual' ? `Made by hand${run.requestedBy ? ` by ${run.requestedBy}` : ''}` : 'Made on schedule'} <span title={fmtDate(run.startedAt)}>{utc(run.startedAt)}</span></span>
          {c && <span>New and resolved findings counted since {utc(c.since)}</span>}
        </div>
      )}
      {run && !c && <Alert tone={run.status === 'failed' ? 'bad' : 'info'} title={run.status === 'failed' ? 'This report could not be made' : 'Still being made'}>{run.error ?? 'Press Refresh in a moment.'}</Alert>}
      {c && s && (
        <>
          {s.findings && s.findings.status !== 'unavailable' && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Open findings" value={whole.format(sumCounts(s.findings.open))} tone={s.findings.open.critical || s.findings.open.high ? 'bad' : undefined} />
              <Stat label="New since last report" value={whole.format(sumCounts(s.findings.fresh))} />
              <Stat label="Resolved since last report" value={whole.format(sumCounts(s.findings.resolved))} tone={sumCounts(s.findings.resolved) ? 'ok' : undefined} />
            </div>
          )}
          <Section c={c} k="changes" runId={runId}>
            {s.changes && s.changes.total > 0 && <>
              <Table head={['Category', 'Changes', 'Created', 'Updated', 'Deleted']} rows={s.changes.byCategory.map((g) => [g.label, whole.format(g.total), g.create, g.update, g.delete])} />
              <h3 className="px-5 pt-3 text-xs font-medium text-muted">Newest changes</h3>
              <Table head={['Time', 'Change', 'Zone', 'Account', 'By']} rows={s.changes.top.map((x) => [utc(x.time), x.title, x.zone, x.account, x.actor])} />
            </>}
            {s.changes?.problems.length ? <Table head={['Account', 'Not read because']} rows={s.changes.problems.map((p) => [p.account, p.error])} /> : null}
          </Section>
          <Section c={c} k="findings" runId={runId}>
            {s.findings && <>
              <Table head={['Severity', 'Open', 'New', 'Resolved']} rows={SEVERITIES.map((v) => [<SeverityBadge key={v} s={v} />, s.findings!.open[v], s.findings!.fresh[v], s.findings!.resolved[v]])} />
              <h3 className="px-5 pt-3 text-xs font-medium text-muted">New since the last report</h3>
              <Table head={['Severity', 'Check', 'Finding', 'Where', 'First seen']} rows={s.findings.freshTop.map((f) => [<SeverityBadge key="s" s={f.severity} />, f.check, f.title, f.where, utc(f.at)])} />
              <h3 className="px-5 pt-3 text-xs font-medium text-muted">Resolved since the last report</h3>
              <Table head={['Severity', 'Check', 'Finding', 'Where', 'Resolved']} rows={s.findings.resolvedTop.map((f) => [<SeverityBadge key="s" s={f.severity} />, f.check, f.title, f.where, utc(f.at)])} />
            </>}
          </Section>
          <Section c={c} k="traffic" runId={runId}>
            {s.traffic?.current && <>
              <Table head={['Period', 'Requests', 'Cached', 'Bandwidth', 'Page views', 'Requests change']} rows={[trafficRow('This period', s.traffic.current, s.traffic.previous), trafficRow('Period before', s.traffic.previous, null)]} />
              {s.traffic.security && <Table head={['Security action', 'Events']} rows={s.traffic.security.byAction.map((a) => [a.action, whole.format(a.count)])} empty="No security events." />}
            </>}
            {s.traffic?.problems.length ? <Table head={['Not read', 'Because']} rows={s.traffic.problems.map((p) => [p.scope, p.error])} /> : null}
          </Section>
          <Section c={c} k="certificates" runId={runId}>
            {s.certificates && s.certificates.total > 0 && (
              <Table head={['Kind', 'Hosts / name', 'Zone or account', 'Status', 'Expires', 'Days left']}
                rows={s.certificates.rows.map((r) => [r.kind, <span key="n" className="font-mono text-xs">{r.name}</span>, r.where, r.status, r.expires?.slice(0, 10) ?? '', r.days === null ? '' : r.days < 0 ? <Badge key="d" tone="bad">expired</Badge> : `${r.days}d`])} />
            )}
          </Section>
          <Section c={c} k="coverage" runId={runId}>
            {s.coverage && <>
              <Table head={['Check', 'Units', 'Read', 'Failing', 'Never read']} rows={s.coverage.checks.map((x) => [x.label, whole.format(x.targets), whole.format(x.read), x.failing, x.never])} />
              {s.coverage.problems.length > 0 && <><h3 className="px-5 pt-3 text-xs font-medium text-muted">Newest failed reads</h3>
                <Table head={['Check', 'Where', 'Reason', 'When']} rows={s.coverage.problems.map((p) => [p.check, p.scope, p.error, p.at ? utc(p.at) : ''])} /></>}
            </>}
          </Section>
        </>
      )}
    </div>
  );
}
