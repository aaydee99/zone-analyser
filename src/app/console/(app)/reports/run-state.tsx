'use client';

import { Badge } from '@/components/ui';
import type { ReportRunSummary } from '@/lib/report-types';

/** A run's state and where it was sent. */
export function RunState({ run }: { run: ReportRunSummary | null }) {
  if (!run) return <span className="text-xs text-faint">Not made yet</span>;
  const sent = Object.entries(run.deliveries);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone={run.status === 'ready' ? 'ok' : run.status === 'failed' ? 'bad' : 'info'}>{run.status === 'ready' ? 'Ready' : run.status === 'failed' ? 'Failed' : 'Being made'}</Badge>
      {sent.map(([ch, d]) => <Badge key={ch} tone={d?.state === 'sent' ? 'ok' : d?.state === 'failed' ? 'bad' : 'neutral'}>{ch === 'slack' ? 'Slack' : 'Webhook'}: {d?.state}</Badge>)}
    </span>
  );
}
