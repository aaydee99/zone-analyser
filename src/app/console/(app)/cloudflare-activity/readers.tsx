'use client';

import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import type { ReadsReport } from '@/lib/cf-insights';
import { Alert, Badge, Button, Card, SectionHeader, SkeletonTable, cx } from '@/components/ui';

const DAYS = [1, 7, 30] as const;
import { whole } from '@/lib/num';

/**
 * Who READ the configuration (Audit Logs v2 "view" entries, which the change timeline leaves out):
 * people and tokens, how often, from where. Read on demand — it can be thousands of entries.
 */
export function Readers({ accounts, accountId }: { accounts: { id: string; name: string }[]; accountId: string }) {
  const [account, setAccount] = useState(accountId);
  const [days, setDays] = useState<(typeof DAYS)[number]>(7);
  const [report, setReport] = useState<ReadsReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  useEffect(() => { if (accountId) setAccount(accountId); }, [accountId]);
  const target = account || accounts[0]?.id || '';

  const load = async (fresh = false) => {
    if (!target) return;
    setBusy(true); setError(''); setAsked(true);
    try { setReport(await api<ReadsReport>(`/api/cloudflare-audit/reads?accountId=${target}&days=${days}${fresh ? '&fresh=1' : ''}`)); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  const shown = report && report.accountId === target && report.days === days ? report : null;
  return (
    <Card className="mt-6">
      <SectionHeader title="Who read the configuration" description="People and API tokens that viewed settings in the dashboard or through the API. Backups and the console’s own reads show up here too." />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          <select className="input !w-auto max-w-full min-w-0 !py-1.5 !text-[13px]" aria-label="Account" value={target} onChange={(e) => setAccount(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select className="input !w-auto !py-1.5 !text-[13px]" aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value) as (typeof DAYS)[number])}>
            {DAYS.map((d) => <option key={d} value={d}>{d === 1 ? 'Last 24 hours' : `Last ${d} days`}</option>)}
          </select>
          <Button size="sm" variant={shown ? 'ghost' : 'primary'} loading={busy} disabled={!target} onClick={() => load(!!shown)} icon={<Eye className="size-3.5" />}>{shown ? 'Read again' : 'Show readers'}</Button>
      </div>
      {error ? <div className="p-5"><Alert tone="bad" title="The audit log could not be read">{error}</Alert></div>
        : busy && !shown ? <div className="p-5"><SkeletonTable rows={5} cols={5} /></div>
          : !shown ? <p className="px-5 py-6 text-[13px] text-muted">{asked ? 'Nothing read yet.' : 'Choose an account and a period, then Show readers.'}</p>
            : shown.readers.length === 0 ? <p className="px-5 py-6 text-[13px] text-muted">Nobody read the configuration in this period.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-[13px]">
                  <thead><tr className="border-b border-line text-muted">{['Who', 'Reads', 'Last read', 'From', 'Mostly'].map((h) => <th key={h} className="px-5 py-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase">{h}</th>)}</tr></thead>
                  <tbody>
                    {shown.readers.slice(0, 100).map((r) => (
                      <tr key={r.actor} className="border-b border-line/60 last:border-0">
                        <td className="px-5 py-2.5"><span className="text-ink">{r.actor}</span> <Badge className="ml-1" tone={r.kind === 'token' ? 'info' : 'neutral'}>{r.kind}</Badge></td>
                        <td className="px-5 py-2.5 font-mono tabular-nums text-ink-2">{whole.format(r.count)}</td>
                        <td className="px-5 py-2.5 text-ink-2" title={fmtDate(r.lastSeen)}>{relTime(r.lastSeen)}</td>
                        <td className="px-5 py-2.5 font-mono text-[12px] text-muted">{r.ips.join(', ') || '—'}</td>
                        <td className={cx('px-5 py-2.5 text-muted')}>{r.products.join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="border-t border-line px-5 py-2.5 text-[11.5px] text-faint">{whole.format(shown.total)} reads{shown.truncated ? ' (the newest 10,000)' : ''} · read {fmtDate(shown.generatedAt)}</p>
              </div>
            )}
    </Card>
  );
}
