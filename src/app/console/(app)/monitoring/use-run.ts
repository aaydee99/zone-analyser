'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import type { CheckId } from '@/lib/monitor-types';

export interface RunState {
  running: boolean;
  startedAt: string | null;
  by: string | null;
  checks: CheckId[];
  current: { check: CheckId; done: number; total: number } | null;
  finishedAt: string | null;
  lastError: string | null;
}

/**
 * Loads `path` now, every 3 seconds while checks run, and every 30 seconds otherwise; reloads once
 * more when a run finishes so the new results show without a click.
 */
export function usePolled<T extends { run?: RunState }>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const was = useRef(false);
  const load = useCallback(() => api<T>(path).then((d) => { setData(d); setError(''); return d; }).catch((e) => { setError((e as Error).message); return null; }), [path]);
  const running = !!data?.run?.running;
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => { void load(); }, running ? 3_000 : 30_000);
    if (was.current && !running) void load();
    was.current = running;
    return () => clearInterval(t);
  }, [load, running]);
  return { data, error, reload: load };
}

/** "Checking certificates · 12 of 40" while a run goes. */
export function runLabel(run: RunState | undefined, labels: Record<string, string>) {
  if (!run?.running) return '';
  const c = run.current;
  if (!c) return 'Starting the checks…';
  return `Checking ${labels[c.check]?.toLowerCase() ?? c.check}${c.total ? ` · ${c.done} of ${c.total}` : '…'}`;
}
