'use client';

import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { SeverityBadge } from '@/components/monitor-view';
import { Alert, Badge, Card, SectionHeader, Stat, cx } from '@/components/ui';
import {
  COVERAGE_LABEL, COVERAGE_STATES, GROUP_LABEL, KIND_LABEL, SEVERITIES, VERDICT_LABEL, windowLabel,
  type AuditFinding, type AuditReport, type AuditStatus, type AuditSummary, type CoverageState, type Effectiveness, type RuleGroup,
} from '@/lib/zone-audit/types';

// The pieces of the audit report page: state, counts, findings, rule effectiveness and the coverage ledger.

const whole = new Intl.NumberFormat();
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function AuditState({ status }: { status: AuditStatus }) {
  return status === 'running' ? <Badge tone="signal">Running</Badge> : status === 'ready' ? <Badge tone="ok">Finished</Badge> : <Badge tone="bad">Failed</Badge>;
}

/** "2 high · 3 medium" (only the severities found), or "No findings". */
export function SeverityCounts({ s }: { s: AuditSummary }) {
  const parts = SEVERITIES.filter((v) => s.bySeverity[v]);
  if (!parts.length) return <span className="text-muted">No findings</span>;
  return <span className="flex flex-wrap gap-1.5">{parts.map((v) => <span key={v} className="inline-flex items-center gap-1"><SeverityBadge s={v} /><span className="tabular-nums text-ink-2">{s.bySeverity[v]}</span></span>)}</span>;
}

const STATE_TONE: Record<CoverageState, 'ok' | 'bad' | 'neutral' | 'warn'> = { passed: 'ok', finding: 'bad', not_applicable: 'neutral', not_read: 'warn' };

export function Summary({ r }: { r: AuditReport }) {
  const s = r.summary;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Findings" value={whole.format(r.findings.length)} sub={`${s.byVerdict.confirmed} confirmed · ${s.byVerdict.needs_validation} need validation`} tone={s.worst === 'critical' || s.worst === 'high' ? 'bad' : s.worst ? 'warn' : 'ok'} />
        <Stat label="Critical + high" value={s.bySeverity.critical + s.bySeverity.high} tone={s.bySeverity.critical + s.bySeverity.high ? 'bad' : 'ok'} />
        <Stat label="Rules checked" value={`${s.coverage.passed + s.coverage.finding} of ${s.rules}`} sub={`${s.coverage.not_applicable} not applicable`} />
        <Stat label="Rules not read" value={s.coverage.not_read} sub={s.coverage.not_read ? 'A clean result does not cover these' : 'Everything applicable was read'} tone={s.coverage.not_read ? 'warn' : 'ok'} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted"><span>By severity:</span><SeverityCounts s={s} /></div>
    </div>
  );
}

function FindingCard({ f }: { f: AuditFinding }) {
  const [open, setOpen] = useState(false);
  const id = `f-${f.fingerprint.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return (
    <li className="border-b border-line/70 last:border-0">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-raised/50">
        <SeverityBadge s={f.severity} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-medium text-ink">{f.title}</span>
          <span className="mt-0.5 block text-xs text-muted">{VERDICT_LABEL[f.verdict]} · {GROUP_LABEL[f.group]} · {f.attackClass}</span>
        </span>
        <ChevronDown className={cx('mt-0.5 size-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div id={id} className="space-y-3 px-5 pb-4 text-[13px] text-ink-2">
          <p>{f.description}</p>
          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted">Root cause</dt><dd>{f.rootCause}</dd>
            <dt className="text-muted">Intended behaviour</dt><dd>{f.intendedBehavior}</dd>
            <dt className="text-muted">Rule</dt><dd><code className="font-mono text-xs">{f.ruleId}</code> · from <span className="font-mono text-xs">{f.skillRef}</span></dd>
          </dl>
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted">Evidence</h4>
            <ul className="space-y-1">{f.evidence.map((e, i) => <li key={i} className="break-words"><span className="font-mono text-[11.5px] text-faint">{e.source}</span> · {e.field}: <code className="font-mono text-xs text-ink">{e.value}</code></li>)}</ul>
          </div>
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted">Fix (not applied — do it in the dashboard)</h4>
            <ol className="list-decimal space-y-1 pl-5">{f.fix.map((x, i) => <li key={i} className="break-words">{x}</li>)}</ol>
          </div>
          {f.validation && <Alert tone="info" title="How to validate">{f.validation}</Alert>}
          <p className="font-mono text-[11px] text-faint">{f.fingerprint}</p>
        </div>
      )}
    </li>
  );
}

export function Findings({ r, section }: { r: AuditReport; section: 'config' | 'traffic' }) {
  const [group, setGroup] = useState<RuleGroup | ''>('');
  const mine = useMemo(() => r.findings.filter((f) => (section === 'traffic' ? f.group === 'traffic' : f.group !== 'traffic')), [r, section]);
  const groups = [...new Set(mine.map((f) => f.group))];
  const shown = group ? mine.filter((f) => f.group === group) : mine;
  const selectId = `group-${section}`;
  return (
    <Card>
      <SectionHeader title={section === 'traffic' ? 'Recommendations from traffic' : 'Configuration findings'} description="Worst first. Open one for its evidence, the fix and how to validate it."
        aside={section === 'config' && groups.length > 1 ? (
          <span className="flex items-center gap-2 text-xs"><label htmlFor={selectId} className="text-muted">Area</label>
            <select id={selectId} className="input py-1 text-xs" value={group} onChange={(e) => setGroup(e.target.value as RuleGroup | '')}>
              <option value="">All ({mine.length})</option>{groups.map((g) => <option key={g} value={g}>{GROUP_LABEL[g]} ({mine.filter((f) => f.group === g).length})</option>)}
            </select></span>) : undefined} />
      {shown.length ? <ul>{shown.map((f) => <FindingCard key={f.fingerprint} f={f} />)}</ul> : <p className="px-5 py-4 text-[13px] text-muted">None in the rules that were read{section === 'traffic' ? ' (see the coverage ledger for the traffic rules)' : ''}.</p>}
    </Card>
  );
}

export function EffectivenessTable({ e, note }: { e: Effectiveness | null; note?: string }) {
  if (!e) return <Card><SectionHeader title="Rule effectiveness" /><div className="px-5 py-4"><Alert tone="warn" title="Traffic was not read">{note ?? 'Security events could not be read.'}</Alert></div></Card>;
  return (
    <Card>
      <SectionHeader title="Rule effectiveness" description={`How each security rule acted ${e.hours ? `in the last ${windowLabel(e.hours)}` : ''} (${e.since.slice(0, 10)} – ${e.until.slice(0, 10)}). ${whole.format(e.totalEvents)} security events, sampled by Cloudflare.`} />
      {e.notes.length > 0 && <ul className="space-y-1 px-5 pt-3 text-xs text-warn">{e.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {!e.rules.length ? <p className="px-5 py-4 text-[13px] text-muted">No security events and no custom or rate limiting rules in the window.</p> : (
        <div className="overflow-x-auto pt-2">
          <table className="w-full min-w-[680px] text-left text-[13px]">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                {['Rule', 'Events', 'Actions', 'Solve rate', 'Trend'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium first:pl-5">{h}</th>)}
                <th scope="col" className="py-2 pr-5 pl-3"><span className="sr-only">Details</span></th>
              </tr>
            </thead>
            <tbody>
              {e.rules.map((x, i) => <EffectRow key={x.key} x={x} total={e.totalEvents} open={i === 0 && x.events > 0} />)}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** One rule: the numbers on one line; its top paths, countries and networks in a panel below. */
function EffectRow({ x, total, open: initial }: { x: Effectiveness['rules'][number]; total: number; open: boolean }) {
  const [open, setOpen] = useState(initial);
  const panel = `effect-${x.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const actions = Object.entries(x.byAction).sort((a, b) => b[1] - a[1]);
  const share = total ? x.events / total : 0;
  const hasDetail = x.topPaths.length + x.topCountries.length + x.topAsns.length > 0;
  return (
    <>
      <tr className={cx('border-t border-line/70 align-top', open && 'bg-raised/30')}>
        <td className="py-2.5 pr-3 pl-5">
          <span className="font-medium text-ink">{x.name}</span>
          <div className="text-xs text-muted">{KIND_LABEL[x.kind]}{x.configAction ? ` · ${x.configAction}` : ''}{x.enabled === false ? ' · disabled' : ''}</div>
        </td>
        <td className="w-36 px-3 py-2.5">
          <span className={cx('tabular-nums', !x.events && 'text-faint')}>{whole.format(x.events)}</span>
          {x.events > 0 && (
            <span className="mt-1 block h-1 w-24 rounded-full bg-line" title={`${pct(share)} of all security events`}>
              <span className="block h-1 rounded-full bg-signal/70" style={{ width: `${Math.max(3, share * 100)}%` }} />
            </span>
          )}
        </td>
        <td className="px-3 py-2.5">
          {actions.length ? (
            <span className="flex flex-wrap gap-1">
              {actions.map(([a, n]) => <span key={a} className="rounded-md border border-line bg-sunken/60 px-1.5 py-0.5 text-[11.5px] text-ink-2">{a.replace(/_/g, ' ')} <span className="tabular-nums text-muted">{whole.format(n)}</span></span>)}
            </span>
          ) : <span className="text-faint">—</span>}
        </td>
        <td className="px-3 py-2.5 tabular-nums">{x.solveRate === null ? <span className="text-faint">—</span> : pct(x.solveRate)}</td>
        <td className="px-3 py-2.5 tabular-nums">{x.trend === null ? <span className="text-faint">{x.previous === null ? '—' : 'new'}</span> : <span className={cx(x.trend > 0.5 ? 'text-warn' : 'text-ink-2')}>{x.trend >= 0 ? '+' : ''}{pct(x.trend)}</span>}</td>
        <td className="py-2 pr-5 pl-3 text-right">
          {hasDetail && (
            <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-raised hover:text-ink">
              Details <ChevronDown aria-hidden="true" className={cx('size-3.5 transition-transform', open && 'rotate-180')} />
            </button>
          )}
        </td>
      </tr>
      {open && hasDetail && (
        <tr id={panel} className="bg-raised/30">
          <td colSpan={6} className="px-5 pt-1 pb-4">
            <div className="grid gap-5 rounded-lg border border-line bg-surface/60 p-4 md:grid-cols-3">
              <RankList title="Top paths" mono items={x.topPaths.map((p) => ({ label: p.path || '/', count: p.count }))} />
              <RankList title="Top countries" items={x.topCountries.map((p) => ({ label: p.country, count: p.count }))} />
              <RankList title="Top networks" items={x.topAsns.map((p) => ({ label: p.name || `AS${p.asn}`, sub: `AS${p.asn}`, count: p.count }))} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** A ranked list with counts and bars; long values are cut short, with the full value on hover. */
function RankList({ title, items, mono }: { title: string; items: { label: string; sub?: string; count: number }[]; mono?: boolean }) {
  const top = items.slice(0, 5);
  const max = Math.max(1, ...top.map((i) => i.count));
  return (
    <div className="min-w-0">
      <h4 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{title}</h4>
      {top.length ? (
        <ol className="space-y-2">
          {top.map((i, n) => (
            <li key={`${i.label}:${n}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
              <span className="min-w-0">
                <span className={cx('block truncate text-[12.5px] text-ink-2', mono && 'font-mono text-[12px]')} title={i.label}>{i.label}</span>
                {i.sub && <span className="block text-[11px] text-faint">{i.sub}</span>}
                <span className="mt-1 block h-1 rounded-full bg-line" aria-hidden="true"><span className="block h-1 rounded-full bg-signal/60" style={{ width: `${Math.max(4, (i.count / max) * 100)}%` }} /></span>
              </span>
              <span className="pt-px text-[12.5px] tabular-nums text-ink-2">{whole.format(i.count)}</span>
            </li>
          ))}
        </ol>
      ) : <p className="text-xs text-faint">None in the window.</p>}
    </div>
  );
}

export function Coverage({ r }: { r: AuditReport }) {
  const [state, setState] = useState<CoverageState | ''>('');
  const rows = state ? r.coverage.filter((c) => c.state === state) : r.coverage;
  return (
    <Card>
      <SectionHeader title="Coverage ledger" description="Every rule and what happened to it: a clean result is only as complete as this list."
        aside={<span className="flex items-center gap-2 text-xs"><label htmlFor="cov-state" className="text-muted">Show</label>
          <select id="cov-state" className="input py-1 text-xs" value={state} onChange={(e) => setState(e.target.value as CoverageState | '')}>
            <option value="">All ({r.coverage.length})</option>{COVERAGE_STATES.map((s) => <option key={s} value={s}>{COVERAGE_LABEL[s]} ({r.summary.coverage[s]})</option>)}
          </select></span>} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="border-b border-line text-xs text-muted"><tr><th scope="col" className="px-5 py-2 font-medium">Rule</th><th scope="col" className="px-3 py-2 font-medium">Area</th><th scope="col" className="px-3 py-2 font-medium">Result</th><th scope="col" className="px-5 py-2 font-medium">Note</th></tr></thead>
          <tbody className="divide-y divide-line/70">
            {rows.map((c) => (
              <tr key={c.ruleId} className="align-top">
                <td className="px-5 py-2"><span className="text-ink">{c.title}</span><div className="font-mono text-[11px] text-faint">{c.ruleId} · {c.skillRef}</div></td>
                <td className="px-3 py-2 text-xs text-muted">{GROUP_LABEL[c.group]}</td>
                <td className="px-3 py-2"><Badge tone={STATE_TONE[c.state]}>{COVERAGE_LABEL[c.state]}{c.state === 'finding' ? ` (${c.findings})` : ''}</Badge></td>
                <td className="px-5 py-2 text-xs text-ink-2">{c.reason}{c.permission && <div className="mt-0.5 text-warn">Needs the token permission “{c.permission}”</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function Method({ r }: { r: AuditReport }) {
  return (
    <Card>
      <SectionHeader title="What was read" description={`${whole.format(r.summary.calls)} Cloudflare API calls (GETs and GraphQL analytics queries) and ${whole.format(r.summary.lookups)} public DNS lookups. Nothing was written.`} />
      <ul className="grid gap-x-6 gap-y-1 px-5 py-3 text-[13px] sm:grid-cols-2">
        {r.reads.map((x) => (
          <li key={x.key} className="flex items-baseline gap-2">
            <span className={cx('size-2 shrink-0 rounded-full', x.state === 'ok' ? 'bg-ok' : x.state === 'absent' ? 'bg-muted' : 'bg-warn')} aria-hidden />
            <span className="text-ink-2">{x.label}</span>
            {x.state !== 'ok' && <span className="truncate text-xs text-muted" title={x.reason}>— {x.state === 'absent' ? 'not on this zone' : x.reason}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
