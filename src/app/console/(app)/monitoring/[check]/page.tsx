'use client';

import { use, useState } from 'react';
import { Play, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import { CHECKS, type CheckView } from '@/lib/monitor-types';
import { Alert, Button, Card, EmptyState, Loading, PageHeader, SkeletonStats, SkeletonTable } from '@/components/ui';
import { FindingList, ProblemList, ReportStats, ReportTable, when } from '@/components/monitor-view';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';
import { coverageLabel, useSnapshot } from '../use-run';
import { AlertsConnect, DriftAccept, RollbackButton } from './extras';

const LABELS = Object.fromEntries(CHECKS.map((c) => [c.id, c.label]));
import { whole } from '@/lib/num';

export default function CheckPage({ params }: { params: Promise<{ check: string }> }) {
  const { check } = use(params);
  const { can } = useMe();
  const toast = useToast();
  const { data, error, loading, reload, version } = useSnapshot<CheckView>(`/api/monitors/${check}`);
  const [starting, setStarting] = useState(false);
  const manage = can('monitors:manage');

  const run = async () => {
    setStarting(true);
    try {
      const r = await api<{ units: number }>('/api/monitors/run', { method: 'POST', json: { checks: [check] } });
      toast(`Checking ${whole.format(r.units)} zones and accounts now — press Refresh to see what is done`, 'info');
    } catch (err) { toast((err as Error).message, 'bad'); } finally { setStarting(false); }
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

  const { meta, coverage } = data;
  const checked = !!coverage.lastRun;
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Monitoring" title={meta.label} description={meta.description}
        actions={<>
          <Button variant="ghost" loading={loading} onClick={reload} icon={<RefreshCw className="size-4" />}>Refresh</Button>
          {manage && <Button variant="primary" loading={starting} onClick={run} icon={<Play className="size-4" />}>Check now</Button>}
        </>} />
      <p className="-mt-4 text-[12.5px] text-muted">
        {coverageLabel(coverage)}{coverage.lastRun && <span title={fmtDate(coverage.lastRun)}> · last read {when(coverage.lastRun)}</span>} · <span title={fmtDate(data.generatedAt)}>as of {new Date(data.generatedAt).toLocaleTimeString()}</span>
      </p>
      {error && <Alert tone="bad" title="This check could not be refreshed">{error} — what is shown is from before.</Alert>}
      {meta.id === 'drift' && checked && manage && <DriftAccept onDone={reload} />}
      {meta.id === 'alerts' && can('restore:approve') && <AlertsConnect />}
      {!checked ? (
        <Card>
          <EmptyState icon={<ShieldCheck className="size-5" />} title={coverage.due ? 'Waiting for its turn' : 'Not checked yet'}
            description={coverage.due ? 'The worker reads each zone and account in turn; press Refresh to see what is done.' : manage ? 'Check now to read every account and zone the stored tokens can reach.' : 'An admin runs the checks, or they run on the schedule set on the Overview tab.'}
            action={manage ? <Button variant="primary" loading={starting} onClick={run} icon={<Play className="size-4" />}>Check now</Button> : undefined} />
        </Card>
      ) : (
        <>
          <ReportStats stats={data.stats} />
          <section aria-labelledby="findings-title" className="space-y-2">
            <h2 id="findings-title" className="text-[15px] font-semibold">Findings</h2>
            <FindingList check={meta.id} counts={data.open} canManage={manage} version={version} empty="Nothing to fix — this check found no problems." />
          </section>
          {data.sections.map((s) => (
            <ReportTable key={s.key} check={meta.id} section={s} version={version} action={
              meta.id === 'drift' && s.key === 'zones' && manage ? (row) => (row.zoneId && Number(row.changes) > 0 ? <DriftAccept zoneId={String(row.zoneId)} zoneName={String(row.zone)} onDone={reload} compact /> : null)
                : meta.id === 'platform' && (s.key === 'workers' || s.key === 'pages') && can('cloudflare:act') ? (row) => <RollbackButton kind={s.key as 'workers' | 'pages'} accountId={String(row.accountId ?? '')} name={String(row.name)} />
                  : undefined
            } />
          ))}
          <ProblemList problems={data.problems} failing={coverage.failing} />
          {meta.needs.length > 0 && <p className="text-[12px] text-faint">Reads with: {meta.needs.join(' · ')}. A permission a token lacks shows up above as a read that could not be completed.</p>}
        </>
      )}
    </div>
  );
}
