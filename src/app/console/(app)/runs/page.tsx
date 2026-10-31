'use client';

import { useEffect, useMemo, useState } from 'react';
import { History, Play } from 'lucide-react';
import { api } from '@/lib/client';
import type { RunMeta, RunStatus } from '@/lib/run-types';
import { Alert, Button, ButtonLink, Card, EmptyState, Loading, PageHeader, Skeleton, SkeletonTable, cx } from '@/components/ui';
import { RunTable } from '@/components/run-table';

const FILTERS: (RunStatus | 'all')[] = ['all', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'];
const PAGE = 200;

export default function RunsPage() {
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [filter, setFilter] = useState<RunStatus | 'all'>('all');
  const [error, setError] = useState('');
  // How many of the newest runs to show; "Show more" asks the API for the next page as well.
  const [limit, setLimit] = useState(PAGE);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = () => api<{ runs: RunMeta[]; more?: boolean }>(`/api/runs?limit=${limit}`)
      .then((r) => { if (stop) return; setRuns(r.runs); setMore(!!r.more); setError(''); })
      .catch((e) => { if (!stop) setError((e as Error).message); })
      .finally(() => { if (!stop) setLoadingMore(false); });
    load();
    const t = setInterval(load, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [limit]);

  const shown = useMemo(() => (runs ?? []).filter((r) => filter === 'all' || r.status === filter), [runs, filter]);

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Audit trail"
        title="Run history"
        description="Every backup started from this console, with its full redacted log."
        actions={<ButtonLink href="/console/backup" variant="primary" icon={<Play className="size-4" />}>New backup</ButtonLink>}
      />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f} className={cx('rounded-lg border px-3 py-1.5 text-[13px] capitalize transition-colors', filter === f ? 'border-line-strong bg-raised text-ink' : 'border-transparent text-muted hover:text-ink-2')}>
            {f} {runs ? <span className="ml-1 font-mono text-[11px] text-faint">{f === 'all' ? runs.length : runs.filter((r) => r.status === f).length}</span> : <Skeleton className="ml-1 !inline-block h-2.5 w-3 align-middle" />}
          </button>
        ))}
      </div>
      <Card>
        {!runs && error ? (
          <div className="p-5"><Alert tone="bad" title="Run history could not be read">{error} — trying again every few seconds.</Alert></div>
        ) : !runs ? (
          <Loading label="Loading run history"><SkeletonTable rows={8} cols={6} className="!rounded-none !border-0" /></Loading>
        ) : shown.length === 0 ? (
          <EmptyState icon={<History className="size-5" />} title="No runs here" description="Backups you start will appear here with live progress and logs." action={<ButtonLink href="/console/backup" variant="primary">Start a backup</ButtonLink>} />
        ) : (
          <RunTable runs={shown} />
        )}
        {runs && more && (
          <div className="flex items-center justify-center gap-3 border-t border-line p-3">
            <span className="text-xs text-muted">Showing the newest {runs.length} runs</span>
            <Button size="sm" loading={loadingMore} onClick={() => { setLoadingMore(true); setLimit((n) => n + PAGE); }}>Show more</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
