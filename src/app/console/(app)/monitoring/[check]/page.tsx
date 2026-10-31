'use client';

import { use, useState } from 'react';
import { Play, ShieldCheck } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import { CHECKS, type CheckView } from '@/lib/monitor-types';
import { Alert, Button, Card, EmptyState, Loading, PageHeader, SkeletonStats, SkeletonTable } from '@/components/ui';
import { FindingList, ProblemList, ReportStats, ReportTable, when } from '@/components/monitor-view';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';
import { runLabel, usePolled, type RunState } from '../use-run';
import { AlertsConnect, DriftAccept, RollbackButton } from './extras';

const LABELS = Object.fromEntries(CHECKS.map((c) => [c.id, c.label]));

export default function CheckPage({ params }: { params: Promise<{ check: string }> }) {
  const { check } = use(params);
  const { can } = useMe();
  const toast = useToast();
  const { data, error, reload } = usePolled<CheckView & { run: RunState }>(`/api/monitors/${check}`);
  const [starting, setStarting] = useState(false);
  const manage = can('monitors:manage');
  const running = !!data?.run.running && data.run.checks.includes(data.meta.id);

  const run = async () => {
    setStarting(true);
    try { await api('/api/monitors/run', { method: 'POST', json: { checks: [check] } }); toast('Checking now — results appear here as soon as they are ready', 'info'); await reload(); }
    catch (err) { toast((err as Error).message, 'bad'); } finally { setStarting(false); }
  };

  if (!data) {
    return (
      <div>
        <PageHeader eyebrow="Monitoring" title={LABELS[check] ?? 'Check'} />
        {error ? <Alert tone="bad" title="This check could not be read">{error}</Alert> : (
          <Loading label="Loading the check"><SkeletonStats count={4} className="mb-5" /><SkeletonTable rows={8} cols={6} /></Loading>
        )}
      </div>
    );
  }

  const { meta, report, findings } = data;
  const status = running ? runLabel(data.run, LABELS) : data.ranAt ? `Checked ${when(data.ranAt)}` : 'Not checked yet';
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Monitoring" title={meta.label} description={meta.description}
        actions={manage && <Button variant="primary" loading={starting || running} onClick={run} icon={<Play className="size-4" />}>{running ? 'Checking…' : 'Check now'}</Button>} />
      <p className="-mt-4 text-[12.5px] text-muted" title={data.ranAt ? fmtDate(data.ranAt) : undefined}>
        {status}{report?.durationMs ? ` · took ${Math.max(1, Math.round(report.durationMs / 1000))} s` : ''}{report?.partial ? ' · partly read (rate limit or a failed account): the rest is read on the next run' : ''}
      </p>
      {data.error && <Alert tone="bad" title="The last run failed">{data.error}{report ? ' — the results below are from the run before.' : ''}</Alert>}
      {meta.id === 'drift' && report && manage && <DriftAccept onDone={reload} />}
      {meta.id === 'alerts' && can('restore:approve') && <AlertsConnect />}
      {!report ? (
        <Card>
          <EmptyState icon={<ShieldCheck className="size-5" />} title={running ? 'Checking now…' : 'Not checked yet'}
            description={running ? 'The first results appear here in a moment.' : manage ? 'Run the check to read every account and zone the stored tokens can reach.' : 'An admin runs the checks, or they run on the schedule set on the Overview tab.'}
            action={manage && !running ? <Button variant="primary" onClick={run} icon={<Play className="size-4" />}>Check now</Button> : undefined} />
        </Card>
      ) : (
        <>
          <ReportStats report={report} />
          <section aria-labelledby="findings-title" className="space-y-2">
            <h2 id="findings-title" className="text-[15px] font-semibold">Findings</h2>
            <FindingList findings={findings} canManage={manage} onChange={reload} empty="Nothing to fix — this check found no problems." />
          </section>
          {report.sections.map((s) => (
            <ReportTable key={s.key} section={s} action={
              meta.id === 'drift' && s.key === 'zones' && manage ? (row) => (row.zoneId && Number(row.changes) > 0 ? <DriftAccept zoneId={String(row.zoneId)} zoneName={String(row.zone)} onDone={reload} compact /> : null)
                : meta.id === 'platform' && (s.key === 'workers' || s.key === 'pages') && can('cloudflare:act') ? (row) => <RollbackButton kind={s.key as 'workers' | 'pages'} accountId={String(row.accountId ?? '')} name={String(row.name)} />
                  : undefined
            } />
          ))}
          <ProblemList problems={report.problems} />
          {meta.needs.length > 0 && <p className="text-[12px] text-faint">Reads with: {meta.needs.join(' · ')}. A permission a token lacks shows up above as a read that could not be completed.</p>}
        </>
      )}
    </div>
  );
}
