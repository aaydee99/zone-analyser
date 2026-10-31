'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { fmtDate, relTime } from '@/lib/client';
import type { RestoreOutcome, RestoreSummary } from '@/lib/restore-history';
import { Badge } from './ui';

export const OUTCOME: Record<RestoreOutcome, { label: string; tone: 'ok' | 'warn' | 'bad' | 'signal' | 'info' | 'neutral' }> = {
  matched: { label: 'Completed · matches backup', tone: 'ok' },
  applied: { label: 'Applied · verified', tone: 'ok' },
  'applied-unverified': { label: 'Applied · not verified', tone: 'warn' },
  failed: { label: 'Apply failed', tone: 'bad' },
  cancelled: { label: 'Apply cancelled', tone: 'warn' },
  'plan-failed': { label: 'Plan failed', tone: 'bad' },
  running: { label: 'Running', tone: 'signal' },
  open: { label: 'Open · not applied yet', tone: 'info' },
  'not-applied': { label: 'Not applied', tone: 'neutral' },
  interrupted: { label: 'Interrupted', tone: 'warn' },
};

export function OutcomeBadge({ outcome }: { outcome: RestoreOutcome }) {
  const o = OUTCOME[outcome];
  return (
    <Badge tone={o.tone}>
      {outcome === 'running' && <span className="live-dot size-1.5 rounded-full bg-live" />}
      {o.label}
    </Badge>
  );
}

export function RestoreTable({ restores }: { restores: RestoreSummary[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-line text-muted">
            {['Outcome', 'Zone', 'Backup', 'Started', 'Changes', ''].map((h) => (
              <th key={h} className="px-5 py-3 text-[11px] font-semibold tracking-[0.1em] uppercase">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {restores.map((r) => (
            <tr key={r.id} className="group border-b border-line/60 last:border-0 hover:bg-raised/40">
              <td className="px-5 py-3.5 whitespace-nowrap"><OutcomeBadge outcome={r.outcome} /></td>
              <td className="px-5 py-3.5">
                <Link href={`/console/restore/history/${r.id}`} className="block font-medium text-ink hover:text-signal">{r.zone.name || '—'}</Link>
                <span className="text-[11px] text-faint">{r.legacy ? 'recorded in the audit log' : r.scan ? 'compare everything' : `${r.auditChanges} audit-log change${r.auditChanges === 1 ? '' : 's'}`}</span>
              </td>
              <td className="max-w-[170px] truncate px-5 py-3.5 font-mono text-[11.5px] text-ink-2" title={r.source.folder}>{r.source.folder || '—'}</td>
              <td className="px-5 py-3.5 text-ink-2" title={fmtDate(r.createdAt)}>
                {relTime(r.createdAt)}
                {r.createdBy && <span className="block max-w-[180px] truncate text-[11px] text-faint" title={r.createdBy}>{r.createdBy}</span>}
              </td>
              <td className="px-5 py-3.5 tabular-nums text-ink-2">{r.planned || (r.legacy && r.selected) || '—'}</td>
              <td className="px-3 py-3.5 text-right">
                <Link href={`/console/restore/history/${r.id}`} className="inline-flex rounded-md p-1.5 text-faint group-hover:text-ink" aria-label="Open restore"><ChevronRight className="size-4" /></Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
