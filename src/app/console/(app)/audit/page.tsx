'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { FileClock, Lock, ScrollText } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import { Badge, Button, Card, EmptyState, PageHeader, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useMe } from '@/components/me';

interface Entry { id: number; at: string; actorEmail: string | null; action: string; target: string | null; details: Record<string, unknown> | null }

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'auth.', label: 'Sign-in' },
  { value: 'vault.', label: 'Vault' },
  { value: 'credential.', label: 'Credentials' },
  { value: 'run.', label: 'Runs' },
  { value: 'user.', label: 'Users' },
  { value: 'preset.', label: 'Presets' },
  { value: 'settings.', label: 'Settings' },
];

const tone = (action: string): 'bad' | 'warn' | 'signal' | 'neutral' =>
  /failed|denied/.test(action) ? 'bad' : /revealed|deleted|disabled|resealed/.test(action) ? 'warn' : action.startsWith('vault.') || action.startsWith('credential.') ? 'signal' : 'neutral';

export default function AuditPage() {
  const toast = useToast();
  const { can } = useMe();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [filter, setFilter] = useState('');
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (before?: number) => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ ...(filter ? { action: filter } : {}), ...(before ? { before: String(before) } : {}) });
      const { entries: page } = await api<{ entries: Entry[] }>(`/api/audit?${q}`);
      setEntries((cur) => (before ? [...cur, ...page] : page));
      setMore(page.length === 100);
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setLoading(false); }
  }, [filter, toast]);
  const allowed = can('audit:read');
  useEffect(() => { if (allowed) load(); }, [load, allowed]);

  if (!allowed) {
    return <Card className="rise mx-auto mt-6 max-w-lg"><EmptyState icon={<Lock className="size-5" />} title="Admins only" description="The audit log is visible to admins and super admins." /></Card>;
  }

  return (
    <div className="rise">
      <PageHeader eyebrow="Access" title="Audit log" description="Every sign-in, vault access, credential change, run and permission change — stored in Supabase."
        actions={<Link href="/changes"><Button icon={<FileClock className="size-4" />}>Recent changes</Button></Link>} />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button key={f.value} onClick={() => setFilter(f.value)} aria-pressed={filter === f.value}
            className={cx('rounded-lg border px-3 py-1.5 text-[13px] transition-colors', filter === f.value ? 'border-line-strong bg-raised text-ink' : 'border-transparent text-muted hover:text-ink-2')}>
            {f.label}
          </button>
        ))}
      </div>
      <Card>
        {!loading && entries.length === 0 ? (
          <EmptyState icon={<ScrollText className="size-5" />} title="Nothing recorded yet" description="Actions appear here as people use the console." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-muted">
                  {['When', 'Who', 'Action', 'Target', 'Details'].map((h) => <th key={h} className="px-5 py-3 text-[11px] font-semibold tracking-[0.1em] uppercase">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-b border-line/60 last:border-0 align-top">
                    <td className="px-5 py-2.5 whitespace-nowrap text-ink-2" title={fmtDate(e.at)}>{relTime(e.at)}</td>
                    <td className="px-5 py-2.5 text-ink-2">{e.actorEmail ?? <span className="text-faint">—</span>}</td>
                    <td className="px-5 py-2.5"><Badge tone={tone(e.action)}><span className="font-mono">{e.action}</span></Badge></td>
                    <td className="max-w-[220px] truncate px-5 py-2.5 font-mono text-xs text-ink-2" title={e.target ?? ''}>{e.target ?? ''}</td>
                    <td className="px-5 py-2.5 font-mono text-[11.5px] break-all text-muted">{e.details ? JSON.stringify(e.details) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more && (
          <div className="flex justify-center border-t border-line p-3">
            <Button size="sm" loading={loading} onClick={() => load(entries[entries.length - 1]?.id)}>Load older</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

