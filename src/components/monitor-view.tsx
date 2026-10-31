'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronDown, ExternalLink, EyeOff, RotateCcw, Search } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import { CHECK, SEVERITIES, type Column, type Finding, type MonitorReport, type ReportProblem, type ReportSection, type Row, type Severity } from '@/lib/monitor-types';
import { Badge, Button, Card, SectionHeader, Stat, cx } from './ui';
import { useToast } from './toast';

// Shared pieces of the monitoring pages: findings, a check's report, its read problems.

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

/** One section of a report: a searchable table that shows 50 rows at a time. */
export function ReportTable({ section, action }: { section: ReportSection; action?: (row: Row) => ReactNode }) {
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? section.rows.filter((r) => section.columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(t))) : section.rows;
  }, [q, section]);
  return (
    <Card>
      <SectionHeader title={section.title} description={section.description} aside={section.rows.length > 10 ? (
        <label className="relative block w-48 shrink-0 sm:w-60">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
          <input className="input !py-1.5 !pl-8 !text-[13px]" placeholder={`Search ${section.rows.length} rows`} value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} aria-label={`Search ${section.title}`} />
        </label>
      ) : <span className="font-mono text-[11px] text-faint">{section.rows.length}</span>} />
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted">{q ? 'Nothing matches.' : section.empty ?? 'Nothing here.'}</p>
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
              {rows.slice(0, shown).map((r, i) => (
                <tr key={i} className={cx('border-b border-line/60 align-top last:border-0 hover:bg-raised/40', r._tone === 'bad' && 'bg-bad/[0.03]')}>
                  {section.columns.map((c) => <td key={c.key} className="max-w-[420px] px-4 py-2.5">{cell(c, r)}</td>)}
                  {action && <td className="px-4 py-2 text-right whitespace-nowrap">{action(r)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > shown && (
            <div className="border-t border-line px-4 py-2.5 text-center">
              <button type="button" className="text-[13px] text-signal hover:underline" onClick={() => setShown((n) => n + PAGE * 4)}>Show more ({rows.length - shown} left)</button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export function ReportStats({ report }: { report: MonitorReport }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {report.stats.slice(0, 4).map((s) => <Stat key={s.label} label={s.label} value={typeof s.value === 'number' ? whole.format(s.value) : s.value} tone={s.tone} />)}
    </div>
  );
}

export function ProblemList({ problems }: { problems: ReportProblem[] }) {
  const [open, setOpen] = useState(false);
  if (!problems.length) return null;
  return (
    <Card className="border-warn/25">
      <button type="button" className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="flex items-center gap-2 text-[13px] text-warn"><AlertTriangle className="size-4" />{problems.length} read{problems.length === 1 ? '' : 's'} could not be completed</span>
        <ChevronDown className={cx('size-4 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="space-y-1.5 border-t border-line px-5 py-3 text-[12.5px]">
          {problems.slice(0, 200).map((p, i) => <li key={i}><span className="font-medium text-ink-2">{p.scope}:</span> <span className="text-muted">{p.error}</span></li>)}
        </ul>
      )}
    </Card>
  );
}

/** Open findings with a severity filter; managers can dismiss or bring back each one. */
export function FindingList({ findings, canManage, onChange, showCheck = false, empty = 'No open findings.' }: {
  findings: Finding[]; canManage: boolean; onChange: () => void; showCheck?: boolean; empty?: string;
}) {
  const toast = useToast();
  const [sev, setSev] = useState<Severity | 'all'>('all');
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState('');
  const visible = findings.filter((f) => (dismissed ? !!f.dismissedAt : !f.dismissedAt) && (sev === 'all' || f.severity === sev));
  const count = (s: Severity) => findings.filter((f) => !f.dismissedAt && f.severity === s).length;
  const act = async (f: Finding, on: boolean) => {
    setBusy(f.id);
    try {
      await api(`/api/monitors/findings/${f.id}`, { method: 'POST', json: { dismissed: on } });
      toast(on ? 'Dismissed — it stays out of counts and notifications' : 'Brought back', 'info');
      onChange();
    } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(''); }
  };
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by severity">
          {(['all', ...SEVERITIES] as const).map((s) => (
            <button key={s} type="button" onClick={() => setSev(s)} aria-pressed={sev === s}
              className={cx('rounded-lg border px-2.5 py-1 text-[12.5px] transition-colors', sev === s ? 'border-line-strong bg-raised text-ink' : 'border-transparent text-muted hover:text-ink-2')}>
              {s === 'all' ? 'All' : SEV_LABEL[s]}{s !== 'all' && <span className="ml-1 font-mono text-[11px] text-faint">{count(s)}</span>}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setDismissed((d) => !d)} className="text-[12.5px] text-muted hover:text-ink-2" aria-pressed={dismissed}>
          {dismissed ? 'Show open findings' : `Show dismissed (${findings.filter((f) => f.dismissedAt).length})`}
        </button>
      </div>
      {visible.length === 0 ? <p className="px-5 py-8 text-center text-sm text-muted">{dismissed ? 'Nothing dismissed.' : empty}</p> : (
        <ul className="divide-y divide-line/60">
          {visible.slice(0, 300).map((f) => (
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
      )}
    </Card>
  );
}
