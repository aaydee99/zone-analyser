'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { History, RotateCcw } from 'lucide-react';
import { api } from '@/lib/client';
import type { RestoreHistory, RestoreOutcome } from '@/lib/restore-history';
import { RestoreTable } from '@/components/restore-table';
import { Button, Card, EmptyState, PageHeader, cx } from '@/components/ui';

const FILTERS: { key: string; label: string; outcomes?: RestoreOutcome[] }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running', outcomes: ['running'] },
  { key: 'applied', label: 'Applied', outcomes: ['applied', 'applied-unverified'] },
  { key: 'matched', label: 'Already matching', outcomes: ['matched'] },
  { key: 'failed', label: 'Failed or cancelled', outcomes: ['failed', 'cancelled', 'plan-failed', 'interrupted'] },
  { key: 'open', label: 'Open', outcomes: ['open'] },
  { key: 'not-applied', label: 'Not applied', outcomes: ['not-applied'] },
];

export default function RestoreHistoryPage() {
  const [history, setHistory] = useState<RestoreHistory | null>(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    const load = () => api<RestoreHistory>('/api/restore/history').then(setHistory).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const all = useMemo(() => history?.restores ?? [], [history]);
  const match = (k: string) => { const f = FILTERS.find((x) => x.key === k)!; return all.filter((r) => !f.outcomes || f.outcomes.includes(r.outcome)); };
  const shown = useMemo(() => match(filter), [all, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Audit trail"
        title="Restore history"
        description="Every restore started from this console: the backup it used, the plan it applied, each step and its full log."
        actions={<Link href="/restore/new"><Button variant="primary" icon={<RotateCcw className="size-4" />}>New restore</Button></Link>}
      />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
            className={cx('rounded-lg border px-3 py-1.5 text-[13px] transition-colors', filter === f.key ? 'border-line-strong bg-raised text-ink' : 'border-transparent text-muted hover:text-ink-2')}>
            {f.label} <span className="ml-1 font-mono text-[11px] text-faint">{match(f.key).length}</span>
          </button>
        ))}
      </div>
      <Card>
        {history && shown.length === 0 ? (
          <EmptyState icon={<History className="size-5" />} title="No restores here" description="Restores you start appear here with their plan, steps and log." action={<Link href="/restore/new"><Button variant="primary">Start a restore</Button></Link>} />
        ) : (
          <RestoreTable restores={shown} />
        )}
      </Card>
    </div>
  );
}
