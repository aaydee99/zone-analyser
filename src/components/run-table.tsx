'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { duration, fmtDate, relTime } from '@/lib/client';
import type { RunMeta } from '@/lib/run-types';
import { Badge, StatusBadge } from './ui';

export function RunTable({ runs }: { runs: RunMeta[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-line text-muted">
            {['Status', 'Run', 'Scope', 'Started', 'Duration', 'Result', ''].map((h) => (
              <th key={h} className="px-5 py-3 text-[11px] font-semibold tracking-[0.1em] uppercase">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const s = r.summary;
            return (
              <tr key={r.id} className="group border-b border-line/60 last:border-0 hover:bg-raised/40">
                <td className="px-5 py-3.5"><StatusBadge status={r.status} /></td>
                <td className="px-5 py-3.5">
                  <Link href={`/console/runs/${r.id}`} className="block font-medium text-ink hover:text-signal">{r.presetName ?? s.account ?? r.credentialNames.cloudflare ?? 'Backup'}</Link>
                  <span className="font-mono text-[11px] text-faint">{r.id}</span>
                </td>
                <td className="px-5 py-3.5 text-ink-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {r.config.zoneMode === 'all' ? 'All zones' : `${r.config.zoneIds.length} zone${r.config.zoneIds.length === 1 ? '' : 's'}`}
                    {r.config.importMode && <Badge>import</Badge>}
                    {r.config.r2.enabled && <Badge className="!border-cyan/25 !bg-cyan/10 !text-cyan">R2</Badge>}
                    {r.config.aws.enabled && <Badge tone="info">S3</Badge>}
                  </div>
                </td>
                <td className="px-5 py-3.5 text-ink-2" title={fmtDate(r.startedAt)}>
                  {relTime(r.startedAt)}
                  {r.startedBy && <span className="block max-w-[180px] truncate text-[11px] text-faint" title={r.startedBy}>{r.startedBy}</span>}
                </td>
                <td className="px-5 py-3.5 font-mono text-xs text-ink-2">{duration(r.startedAt, r.endedAt)}</td>
                <td className="px-5 py-3.5">
                  {r.status === 'running' ? <span className="text-muted">{s.zonesTotal ? `zone ${s.zonesDone ?? 0}/${s.zonesTotal}` : 'starting…'}</span>
                    : s.gaps === false ? <Badge tone="ok">Clean</Badge>
                      : s.gaps ? <Badge tone="warn">{(s.apiErrors ?? 0) + (s.quarantined ?? 0) + (s.generateFailures ?? 0)} gaps</Badge>
                        : s.errors ? <Badge tone="bad">{s.errors} errors</Badge> : <span className="text-faint">—</span>}
                </td>
                <td className="px-3 py-3.5 text-right">
                  <Link href={`/console/runs/${r.id}`} className="inline-flex rounded-md p-1.5 text-faint group-hover:text-ink" aria-label="Open run"><ChevronRight className="size-4" /></Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
