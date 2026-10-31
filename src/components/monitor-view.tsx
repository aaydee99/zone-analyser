'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronDown, ExternalLink, EyeOff, RotateCcw, Search } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import { CHECK, SEVERITIES, type CheckId, type Column, type Finding, type FindingsPage, type ReportProblem, type ReportStat, type Row, type RowsPage, type SectionView, type Severity } from '@/lib/monitor-types';
import { Badge, Button, Card, SectionHeader, SkeletonTable, Stat, cx } from './ui';
import { useToast } from './toast';

// Shared pieces of the monitoring pages: findings, a check's tables and stats, its read problems.
// Tables and findings come from the server a page at a time: a check can cover thousands of zones.

const SEV_TONE: Record<Severity, 'bad' | 'warn' | 'info' | 'neutral'> = { critical: 'bad', high: 'bad', medium: 'warn', low: 'info', info: 'neutral' };
const SEV_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

export function SeverityBadge({ s }: { s: Severity }) {
  return <Badge tone={SEV_TONE[s]} className={s === 'critical' ? '!border-bad/50 !bg-bad/20 font-semibold' : ''}>{SEV_LABEL[s]}</Badge>;
}

const whole = new Intl.NumberFormat();

/** "3d ago" for the past, "in 12d" for the future (expiry dates). */
export function when(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 45) return relTime(iso);
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  // Whole days left, counted like the "days left" column (rounded down).
  if (s < 60 * 86400) return `in ${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function DaysCell({ v }: { v: number }) {
  const cls = v < 0 ? 'text-bad' : v <= 7 ? 'text-bad' : v <= 30 ? 'text-warn' : 'text-ink-2';
  return <span className={cx('font-mono text-xs tabular-nums', cls)}>{v < 0 ? 'expired' : `${whole.format(v)}d`}</span>;
}

function cell(c: Column, row: Row): ReactNode {
  const v = row[c.key];
  if (v === null || v === undefined || v === '') return <span className="text-faint">—</span>;
  switch (c.kind) {
    case 'mono': return <span className="font-mono text-[12px] break-all text-ink-2">{String(v)}</span>;
    case 'date': return <span className="whitespace-nowrap text-ink-2" title={fmtDate(String(v))}>{when(String(v))}</span>;
    case 'days': return <DaysCell v={Number(v)} />;
    case 'number': return <span className="font-mono text-xs tabular-nums text-ink-2">{whole.format(Number(v))}</span>;
    case 'status': return <Badge tone={row._tone === 'bad' ? 'bad' : row._tone === 'warn' ? 'warn' : row._tone === 'ok' ? 'ok' : row._tone === 'info' ? 'info' : 'neutral'}>{String(v).replace(/_/g, ' ')}</Badge>;
    case 'severity': return <SeverityBadge s={v as Severity} />;
    case 'bool': return v ? <Badge tone="ok">Yes</Badge> : <Badge tone="warn">No</Badge>;
    case 'link': return /^https:\/\//.test(String(v)) ? <a href={String(v)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-signal hover:underline">Guide <ExternalLink className="size-3" /></a> : null;
    default: return <span className="text-ink-2">{String(v)}</span>;
  }
}

const PAGE = 50;

/** Waits until `value` has stopped changing for `ms`. */
function useSettled<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** One table of a check: searchable, 50 rows at a time from the server. Reloads when `version` changes. */
export function ReportTable({ check, section, version, action }: { check: CheckId; section: SectionView; version: number; action?: (row: Row) => ReactNode }) {
  const [q, setQ] = useState('');
  const term = useSettled(q.trim());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(section.total);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const page = useCallback((offset: number) => api<RowsPage>(`/api/monitors/${check}/rows?section=${encodeURIComponent(section.key)}&offset=${offset}&limit=${offset ? PAGE * 4 : PAGE}${term ? `&q=${encodeURIComponent(term)}` : ''}`), [check, section.key, term]);
  useEffect(() => {
    let live = true;
    if (!section.total && !term) { setRows([]); setTotal(0); return; }
    page(0).then((p) => { if (live) { setRows(p.rows); setTotal(p.total); setError(''); } }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [page, version, section.total, term]);
  const loadMore = async () => {
    setMore(true);
    try { const p = await page(rows?.length ?? 0); setRows((r) => [...(r ?? []), ...p.rows]); setTotal(p.total); } catch (e) { setError((e as Error).message); } finally { setMore(false); }
  };
  return (
    <Card>
      <SectionHeader title={section.title} description={section.description} aside={section.total > 10 ? (
        <label className="relative block w-48 shrink-0 sm:w-60">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
          <input className="input !py-1.5 !pl-8 !text-[13px]" placeholder={`Search ${whole.format(section.total)} rows`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${section.title}`} />
        </label>
      ) : <span className="font-mono text-[11px] text-faint">{section.total}</span>} />
      {error ? <p className="px-5 py-6 text-sm text-bad">{error}</p>
        : rows === null ? <div className="p-5"><SkeletonTable rows={5} cols={Math.min(6, section.columns.length)} /></div>
          : rows.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted">{term ? 'Nothing matches.' : section.empty ?? 'Nothing here.'}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line text-muted">
                    {section.columns.map((c) => <th key={c.key} className="px-4 py-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase">{c.label}</th>)}
                    {action && <th className="px-4 py-2.5" />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className={cx('border-b border-line/60 align-top last:border-0 hover:bg-raised/40', r._tone === 'bad' && 'bg-bad/[0.03]')}>
                      {section.columns.map((c) => <td key={c.key} className="max-w-[420px] px-4 py-2.5">{cell(c, r)}</td>)}
                      {action && <td className="px-4 py-2 text-right whitespace-nowrap">{action(r)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              {total > rows.length && (
                <div className="border-t border-line px-4 py-2.5 text-center">
                  <Button size="sm" variant="ghost" loading={more} onClick={loadMore}>Show more ({whole.format(total - rows.length)} left)</Button>
                </div>
              )}
            </div>
          )}
    </Card>
  );
}

export function ReportStats({ stats }: { stats: ReportStat[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {stats.slice(0, 4).map((s) => <Stat key={s.label} label={s.label} value={typeof s.value === 'number' ? whole.format(s.value) : s.value} tone={s.tone} />)}
    </div>
  );
}

export function ProblemList({ problems, failing }: { problems: ReportProblem[]; failing: number }) {
  const [open, setOpen] = useState(false);
  if (!problems.length) return null;
  const n = Math.max(failing, problems.length);
  return (
    <Card className="border-warn/25">
      <button type="button" className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="flex items-center gap-2 text-[13px] text-warn"><AlertTriangle className="size-4" />{whole.format(n)} zone{n === 1 ? '' : 's'} or account{n === 1 ? '' : 's'} could not be read in full</span>
        <ChevronDown className={cx('size-4 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="space-y-1.5 border-t border-line px-5 py-3 text-[12.5px]">
          {problems.map((p, i) => <li key={i}><span className="font-medium text-ink-2">{p.scope}:</span> <span className="text-muted">{p.error}</span>{p.at && <span className="ml-1.5 text-faint" title={fmtDate(p.at)}>{relTime(p.at)}</span>}</li>)}
          {n > problems.length && <li className="text-faint">…and {whole.format(n - problems.length)} more. They are read again on their own, sooner after each failure.</li>}
        </ul>
      )}
    </Card>
  );
}

/**
 * Open findings, worst first, 50 at a time, with a severity filter; managers can dismiss or bring
 * back each one. `counts` are the open counts per severity (from the page's snapshot).
 */
export function FindingList({ check, counts, canManage, version, onChange, showCheck = false, empty = 'No open findings.' }: {
  check?: CheckId; counts: Record<Severity, number>; canManage: boolean; version: number; onChange?: () => void; showCheck?: boolean; empty?: string;
}) {
  const toast = useToast();
  const [sev, setSev] = useState<Severity | 'all'>('all');
  const [dismissed, setDismissed] = useState(false);
  const [list, setList] = useState<Finding[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [more, setMore] = useState(false);
  const [mine, setMine] = useState(0);
  const page = useCallback((offset: number) => {
    const p = new URLSearchParams({ offset: String(offset), limit: String(PAGE) });
    if (check) p.set('check', check);
    if (sev !== 'all') p.set('severity', sev);
    if (dismissed) p.set('dismissed', '1');
    return api<FindingsPage>(`/api/monitors/findings?${p}`);
  }, [check, sev, dismissed]);
  useEffect(() => {
    let live = true;
    page(0).then((p) => { if (live) { setList(p.findings); setTotal(p.total); setError(''); } }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [page, version, mine]);
  const loadMore = async () => {
    setMore(true);
    try { const p = await page(list?.length ?? 0); setList((l) => [...(l ?? []), ...p.findings]); setTotal(p.total); } catch (e) { setError((e as Error).message); } finally { setMore(false); }
  };
  const act = async (f: Finding, on: boolean) => {
    setBusy(f.id);
    try {
      await api(`/api/monitors/findings/${f.id}`, { method: 'POST', json: { dismissed: on } });
      toast(on ? 'Dismissed — it stays out of counts and notifications' : 'Brought back', 'info');
      setMine((n) => n + 1);
      onChange?.();
    } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(''); }
  };
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by severity">
          {(['all', ...SEVERITIES] as const).map((s) => (
            <button key={s} type="button" onClick={() => setSev(s)} aria-pressed={sev === s}
              className={cx('rounded-lg border px-2.5 py-1 text-[12.5px] transition-colors', sev === s ? 'border-line-strong bg-raised text-ink' : 'border-transparent text-muted hover:text-ink-2')}>
              {s === 'all' ? 'All' : SEV_LABEL[s]}{s !== 'all' && <span className="ml-1 font-mono text-[11px] text-faint">{whole.format(counts[s] ?? 0)}</span>}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setDismissed((d) => !d)} className="text-[12.5px] text-muted hover:text-ink-2" aria-pressed={dismissed}>
          {dismissed ? 'Show open findings' : 'Show dismissed'}
        </button>
      </div>
      {error ? <p className="px-5 py-6 text-sm text-bad">{error}</p>
        : list === null ? <div className="p-5"><SkeletonTable rows={4} cols={3} /></div>
          : list.length === 0 ? <p className="px-5 py-8 text-center text-sm text-muted">{dismissed ? 'Nothing dismissed.' : empty}</p> : (
            <>
              <ul className="divide-y divide-line/60">
                {list.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-start gap-3 px-5 py-3">
                    <div className="w-[74px] shrink-0 pt-0.5"><SeverityBadge s={f.severity} /></div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] text-ink">{f.title}</div>
                      {f.detail && <div className="mt-0.5 text-[12.5px] text-muted">{f.detail}</div>}
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-faint">
                        {showCheck && <Link href={`/console/monitoring/${f.check}`} className="text-signal hover:underline">{CHECK[f.check]?.label ?? f.check}</Link>}
                        {(f.accountName || f.zoneName) && <span>{[f.accountName, f.zoneName].filter(Boolean).join(' › ')}</span>}
                        <span title={fmtDate(f.firstSeen)}>found {relTime(f.firstSeen)}</span>
                        {f.dismissedAt && <span>dismissed by {f.dismissedBy} {relTime(f.dismissedAt)}</span>}
                      </div>
                    </div>
                    {canManage && (
                      <Button size="sm" variant="ghost" loading={busy === f.id} onClick={() => act(f, !f.dismissedAt)} icon={f.dismissedAt ? <RotateCcw className="size-3.5" /> : <EyeOff className="size-3.5" />}>
                        {f.dismissedAt ? 'Bring back' : 'Dismiss'}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {total > list.length && (
                <div className="border-t border-line px-4 py-2.5 text-center">
                  <Button size="sm" variant="ghost" loading={more} onClick={loadMore}>Show more ({whole.format(total - list.length)} left)</Button>
                </div>
              )}
            </>
          )}
    </Card>
  );
}
