'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, ExternalLink, Loader2, XCircle } from 'lucide-react';
import type { WorkerSummary } from '@/lib/live-state';
import { cx } from './ui';

const secs = (from: string | null, to = Date.now()) => (from ? Math.max(0, Math.round((to - Date.parse(from)) / 1000)) : 0);
const dur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`);

/** The worker's GitHub Actions run, step by step, while it starts (shown on every page). */
export function WorkerStarting({ w }: { w: WorkerSummary }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const p = w.start;
  const steps = p?.steps ?? [];
  const failed = p?.status === 'completed' && p.conclusion !== 'success';
  const done = steps.filter((s) => s.status === 'completed').length;
  // The last step (running the worker) stays "in progress" for the whole session: it is "almost there".
  const current = steps.find((s) => s.status === 'in_progress');
  const pct = !p || !steps.length ? (p?.status === 'queued' ? 5 : 2) : Math.min(98, Math.round(((done + (current ? 0.5 : 0)) / steps.length) * 100));
  const headline = failed ? 'Starting the worker failed'
    : !p || p.status === 'requested' ? 'Asking GitHub to start the worker…'
    : p.status === 'queued' || p.status === 'waiting' ? 'Waiting for a GitHub runner…'
    : current?.name === 'Run the worker' ? 'Starting the worker… almost there'
    : `Starting the worker… ${current?.name ?? ''}`;

  return (
    <div role="status" className={cx('mb-6 rounded-xl border px-4 py-3 text-[13px]', failed ? 'border-bad/40 bg-bad/[0.07]' : 'border-warn/40 bg-warn/[0.07]')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {failed ? <XCircle className="size-4 shrink-0 text-bad" aria-hidden /> : <Loader2 className="size-4 shrink-0 animate-spin text-warn" aria-hidden />}
        <b className={failed ? 'text-bad' : 'text-warn'}>{headline}</b>
        <span className="text-xs text-muted tabular-nums">
          {w.startingSince ? `asked ${dur(secs(w.startingSince))} ago` : ''}{p?.startedAt ? ` · running ${dur(secs(p.startedAt))}` : ''}
        </span>
        {p?.url && (
          <a href={p.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-signal hover:underline">
            Live log on GitHub <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </div>
      {!failed && (
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-line" aria-hidden>
          <div className="progress-live h-full rounded-full bg-warn transition-[width] duration-700" style={{ width: `${pct}%` }} />
        </div>
      )}
      {steps.length > 0 && (
        <ol className="mt-2.5 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s) => {
            const bad = s.status === 'completed' && s.conclusion !== 'success' && s.conclusion !== 'skipped';
            const t = s.status === 'completed' ? secs(s.startedAt, s.completedAt ? Date.parse(s.completedAt) : Date.now()) : s.status === 'in_progress' ? secs(s.startedAt) : 0;
            return (
              <li key={s.name} className={cx('flex min-w-0 items-center gap-1.5', s.status === 'in_progress' ? 'text-ink' : s.status === 'completed' ? 'text-ink-2' : 'text-faint')}>
                {bad ? <XCircle className="size-3.5 shrink-0 text-bad" aria-hidden />
                  : s.status === 'completed' ? <CheckCircle2 className="size-3.5 shrink-0 text-ok" aria-hidden />
                    : s.status === 'in_progress' ? <Loader2 className="size-3.5 shrink-0 animate-spin text-warn" aria-hidden />
                      : <Circle className="size-3.5 shrink-0" aria-hidden />}
                <span className="truncate">{s.name}</span>
                {t > 0 && <span className="ml-auto shrink-0 tabular-nums text-faint">{dur(t)}</span>}
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-2 text-xs text-muted">
        {failed
          ? <>A step failed: open the live log on GitHub to see why (often a missing repository secret). The console asks GitHub again a few minutes after the first request.</>
          : <>The worker runs on GitHub Actions and takes about 2–3 minutes to start. Backups, restores, the vault and Cloudflare pages work once it is online.</>}
      </p>
    </div>
  );
}
