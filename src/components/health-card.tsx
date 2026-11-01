'use client';

import { compactNum } from '@/lib/num';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { HeartPulse } from 'lucide-react';
import { api } from '@/lib/client';
import { scoreTone, type HealthSummary } from '@/lib/zone-health-types';
import { Card, Loading, Skeleton, cx } from './ui';

interface View { summary: HealthSummary; worst: { zoneId: string; zoneName: string; score: number }[] }

const tone = (s: number) => ({ bad: 'text-bad', warn: 'text-warn', ok: 'text-ok' })[scoreTone(s)];

/** The Overview's zone health card: the average score, zones below 50, and the five worst (stored scores only). */
export function HealthCard() {
  const [v, setV] = useState<View | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => { api<View>('/api/zone-health/summary').then(setV, () => setGone(true)); }, []);
  // Not set up (0018 missing) or no monitoring yet: the Overview stays as it was.
  if (gone || (v && !v.summary.zones)) return null;
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold"><HeartPulse className="size-4 text-muted" />Zone health</h2>
        <Link href="/console/health" className="text-[13px] text-muted hover:text-ink">Worst 20 →</Link>
      </div>
      {!v ? <Loading label="Loading zone health"><div className="space-y-2 p-5"><Skeleton className="h-6 w-20" /><Skeleton className="h-3 w-40" /></div></Loading> : (
        <div className="px-5 py-4">
          <div className="flex items-baseline gap-3">
            <span className={cx('text-[28px] font-semibold tabular-nums', v.summary.average === null ? 'text-ink' : tone(v.summary.average))}>{v.summary.average ?? '—'}</span>
            <span className="text-xs text-muted">average of {compactNum(v.summary.zones)} zones · {compactNum(v.summary.poor)} below 50</span>
          </div>
          {v.worst.length > 0 && (
            <ul className="mt-3 space-y-1 text-[13px]">
              {v.worst.map((w) => <li key={w.zoneId} className="flex justify-between gap-3"><span className="truncate text-ink-2">{w.zoneName || w.zoneId}</span><span className={cx('font-mono tabular-nums', tone(w.score))}>{w.score}</span></li>)}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
