'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import type { Coverage } from '@/lib/monitor-types';

/**
 * Loads `path` once and keeps what it got: the page stays as it is until someone presses Refresh
 * (`reload`), while the worker keeps checking in the background. `version` goes up with each load,
 * so the tables and findings below reload with it.
 */
export function useSnapshot<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await api<T>(path)); setError(''); setVersion((v) => v + 1); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload, version };
}

import { whole } from '@/lib/num';

/** "6,410 of 6,532 read · 122 waiting · 3 failing". */
export function coverageLabel(c: Coverage) {
  if (!c.targets) return 'Not checked yet';
  const parts = [`${whole.format(c.read)} of ${whole.format(c.targets)} read`];
  if (c.never) parts.push(`${whole.format(c.never)} not read yet`);
  else if (c.due) parts.push(`${whole.format(c.due)} waiting`);
  if (c.failing) parts.push(`${whole.format(c.failing)} failing`);
  return parts.join(' · ');
}

/** "Every 6 hours" for an interval in hours. */
export const every = (h: number) => (h < 1 ? `Every ${Math.round(h * 60)} minutes` : h === 1 ? 'Every hour' : h === 168 ? 'Every week' : h % 24 === 0 ? (h === 24 ? 'Every day' : `Every ${h / 24} days`) : `Every ${h} hours`);
