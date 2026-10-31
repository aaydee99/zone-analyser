'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { History, Play } from 'lucide-react';
import { api } from '@/lib/client';
import type { RunMeta, RunStatus } from '@/lib/run-types';
import { Button, Card, EmptyState, PageHeader, cx } from '@/components/ui';
import { RunTable } from '@/components/run-table';

const FILTERS: (RunStatus | 'all')[] = ['all', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'];

export default function RunsPage() {
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [filter, setFilter] = useState<RunStatus | 'all'>('all');

  useEffect(() => {
    const load = () => api<{ runs: RunMeta[] }>('/api/runs').then((r) => setRuns(r.runs)).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const shown = useMemo(() => (runs ?? []).filter((r) => filter === 'all' || r.status === filter), [runs, filter]);

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Audit trail"
        title="Run history"
        description="Every backup started from this console, with its full redacted log."
        actions={<Link href="/backup"><Button variant="primary" icon={<Play className="size-4" />}>New backup</Button></Link>}
      />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={cx('rounded-lg border px-3 py-1.5 text-[13px] capitalize transition-colors', filter === f ? 'border-line-strong bg-raised text-ink' : 'border-transparent text-muted hover:text-ink-2')}>
            {f} <span className="ml-1 font-mono text-[11px] text-faint">{f === 'all' ? runs?.length ?? 0 : runs?.filter((r) => r.status === f).length ?? 0}</span>
          </button>
        ))}
      </div>
      <Card>
        {runs && shown.length === 0 ? (
          <EmptyState icon={<History className="size-5" />} title="No runs here" description="Backups you start will appear here with live progress and logs." action={<Link href="/backup"><Button variant="primary">Start a backup</Button></Link>} />
        ) : (
          <RunTable runs={shown} />
        )}
      </Card>
    </div>
  );
}
