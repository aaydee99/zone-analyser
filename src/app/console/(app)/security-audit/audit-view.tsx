'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { SeverityBadge } from '@/components/monitor-view';
import { Alert, Badge, Card, SectionHeader, Stat, cx } from '@/components/ui';
import {
  COVERAGE_LABEL, COVERAGE_STATES, GROUP_LABEL, KIND_LABEL, PASS_LABEL, SEVERITIES, SEVERITY_LABEL, VERDICT_LABEL, windowLabel,
  type ActionItem, type AuditFinding, type AuditReport, type AuditStatus, type AuditSummary, type CoverageState, type Effectiveness, type ManagedOverview, type PassThrough,
  type Recommendation, type RuleGroup, type RuleKind, type Severity, type Verdict,
} from '@/lib/zone-audit/types';

// The pieces of the audit report page: state, counts, findings, recommended actions, rule
// effectiveness, managed rulesets and the coverage ledger. Links between tabs (an action to its
// finding, an exception to its traffic) go through AuditNav: it switches the tab and the element
// with that id opens itself and scrolls into view.

import { whole } from '@/lib/num';
const pct = (x: number) => `${Math.round(x * 100)}%`;

export type AuditTab = 'findings' | 'actions' | 'effectiveness' | 'managed' | 'coverage';
/** Opens a finding (Findings tab) or an Effectiveness row by its fingerprint or rule key. */
export const AuditNav = createContext<{ finding: (fingerprint: string) => void; effect: (key: string) => void }>({ finding: () => {}, effect: () => {} });
export const findingId = (fp: string) => `f-${fp.replace(/[^A-Za-z0-9_-]/g, '_')}`;
export const effectId = (key: string) => `effect-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
/** True (once) when the URL hash names this element: it then opens and scrolls into view. */
function useTargeted(id: string) {
  const [hit, setHit] = useState(false);
  useEffect(() => {
    const check = () => { if (window.location.hash === `#${id}`) { setHit(true); requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' })); } };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [id]);
  return hit;
}

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
        <Stat label="Checks read" value={`${s.coverage.passed + s.coverage.finding} of ${s.rules}`} sub={`${s.coverage.not_applicable} not applicable to this zone`} />
        <Stat label="Rules not read" value={s.coverage.not_read} sub={s.coverage.not_read ? 'A clean result does not cover these' : 'Everything applicable was read'} tone={s.coverage.not_read ? 'warn' : 'ok'} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted"><span>By severity:</span><SeverityCounts s={s} /></div>
    </div>
  );
}

function FindingCard({ f }: { f: AuditFinding }) {
  const id = findingId(f.fingerprint);
  const targeted = useTargeted(id);
  const [opened, setOpen] = useState(false);
  const open = opened || targeted;
  return (
    <li id={id} className="scroll-mt-20 border-b border-line/70 last:border-0">
      <button type="button" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-raised/50">
        <SeverityBadge s={f.severity} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-medium text-ink">{f.title}</span>
          <span className="mt-0.5 block text-xs text-muted">{VERDICT_LABEL[f.verdict]} · {GROUP_LABEL[f.group]} · {f.attackClass}</span>
        </span>
        <ChevronDown className={cx('mt-0.5 size-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div id={`${id}-body`} className="space-y-3 px-5 pb-4 text-[13px] text-ink-2">
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

/** A list of findings, worst first, with severity, verdict and area filters. */
export function Findings({ findings, title, description, filters = true }: { findings: AuditFinding[]; title: string; description?: string; filters?: boolean }) {
  const [sev, setSev] = useState<Severity | ''>('');
  const [verdict, setVerdict] = useState<Verdict | ''>('');
  const [group, setGroup] = useState<RuleGroup | ''>('');
  const groups = useMemo(() => [...new Set(findings.map((f) => f.group))], [findings]);
  const shown = findings.filter((f) => (!sev || f.severity === sev) && (!verdict || f.verdict === verdict) && (!group || f.group === group));
  const sel = 'input py-1 text-xs';
  const key = title.replace(/\W+/g, '-').toLowerCase();
  return (
    <Card>
      <SectionHeader title={title} description={description ?? 'Worst first. Open one for its evidence, the fix and how to validate it.'} />
      {filters && findings.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-2.5 text-xs">
          <label className="flex items-center gap-1.5"><span className="text-muted">Severity</span>
            <select className={sel} value={sev} onChange={(e) => setSev(e.target.value as Severity | '')} id={`${key}-sev`}>
              <option value="">All</option>{SEVERITIES.filter((v) => findings.some((f) => f.severity === v)).map((v) => <option key={v} value={v}>{SEVERITY_LABEL[v]} ({findings.filter((f) => f.severity === v).length})</option>)}
            </select></label>
          <label className="flex items-center gap-1.5"><span className="text-muted">Verdict</span>
            <select className={sel} value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict | '')} id={`${key}-verdict`}>
              <option value="">All</option>{(['confirmed', 'needs_validation'] as Verdict[]).map((v) => <option key={v} value={v}>{VERDICT_LABEL[v]} ({findings.filter((f) => f.verdict === v).length})</option>)}
            </select></label>
          {groups.length > 1 && <label className="flex items-center gap-1.5"><span className="text-muted">Area</span>
            <select className={sel} value={group} onChange={(e) => setGroup(e.target.value as RuleGroup | '')} id={`${key}-area`}>
              <option value="">All</option>{groups.map((g) => <option key={g} value={g}>{GROUP_LABEL[g]} ({findings.filter((f) => f.group === g).length})</option>)}
            </select></label>}
          {shown.length !== findings.length && <span className="text-muted">{shown.length} of {findings.length}</span>}
        </div>
      )}
      {shown.length ? <ul>{shown.map((f) => <FindingCard key={f.fingerprint} f={f} />)}</ul> : <p className="px-5 py-4 text-[13px] text-muted">None in the rules that were read{findings.length ? ' with these filters' : ''} — the coverage ledger shows which rules were read.</p>}
    </Card>
  );
}

export function EffectivenessTable({ e, note, only, title = 'Rule effectiveness' }: { e: Effectiveness | null; note?: string; only?: RuleKind; title?: string }) {
  const [kind, setKind] = useState<RuleKind | ''>(only ?? '');
  if (!e) return <Card><SectionHeader title={title} /><div className="px-5 py-4"><Alert tone="warn" title="Traffic was not read">{note ?? 'Security events could not be read.'}</Alert></div></Card>;
  const kinds = [...new Set(e.rules.map((x) => x.kind))];
  const rules = kind ? e.rules.filter((x) => x.kind === kind) : e.rules;
  return (
    <Card>
      <SectionHeader title={title} description={`How each security rule acted ${e.hours ? `in the last ${windowLabel(e.hours)}` : ''} (${e.since.slice(0, 10)} – ${e.until.slice(0, 10)}). ${whole.format(e.totalEvents)} security events, sampled by Cloudflare.`}
        aside={!only && kinds.length > 1 ? (
          <label className="flex items-center gap-2 text-xs"><span className="text-muted">Rules</span>
            <select className="input py-1 text-xs" value={kind} onChange={(ev) => setKind(ev.target.value as RuleKind | '')}>
              <option value="">All ({e.rules.length})</option>{kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]} ({e.rules.filter((x) => x.kind === k).length})</option>)}
            </select></label>) : undefined} />
      {e.notes.length > 0 && <ul className="space-y-1 px-5 pt-3 text-xs text-warn">{e.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {!rules.length ? <p className="px-5 py-4 text-[13px] text-muted">{only ? `No ${KIND_LABEL[only].toLowerCase()} events in the window.` : 'No security events and no custom or rate limiting rules in the window.'}</p> : (
        <div className="overflow-x-auto pt-2">
          <table className="w-full min-w-[680px] text-left text-[13px]">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                {['Rule', 'Events', 'Actions', 'Solve rate', 'Trend'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium first:pl-5">{h}</th>)}
                <th scope="col" className="py-2 pr-5 pl-3"><span className="sr-only">Details</span></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((x, i) => <EffectRow key={x.key} x={x} total={e.totalEvents} open={i === 0 && x.events > 0} />)}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** One rule: the numbers on one line; its top paths, countries and networks in a panel below. */
function EffectRow({ x, total, open: initial }: { x: Effectiveness['rules'][number]; total: number; open: boolean }) {
  const panel = effectId(x.key);
  const targeted = useTargeted(panel);
  const [toggled, setOpen] = useState<boolean | null>(null);
  const open = toggled ?? (initial || targeted);
  const actions = Object.entries(x.byAction).sort((a, b) => b[1] - a[1]);
  const share = total ? x.events / total : 0;
  const hasDetail = x.topPaths.length + x.topCountries.length + x.topAsns.length > 0 || !!x.passthrough;
  return (
    <>
      <tr id={`${panel}-row`} className={cx('border-t border-line/70 align-top', open && 'bg-raised/30')}>
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
            <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-raised hover:text-ink">
              Details <ChevronDown aria-hidden="true" className={cx('size-3.5 transition-transform', open && 'rotate-180')} />
            </button>
          )}
        </td>
      </tr>
      {open && hasDetail && (
        <tr id={panel} className="bg-raised/30">
          <td colSpan={6} className="px-5 pt-1 pb-4">
            {x.topPaths.length + x.topCountries.length + x.topAsns.length > 0 ? (
              <div className="grid gap-5 rounded-lg border border-line bg-surface/60 p-4 md:grid-cols-3">
                <RankList title="Top paths" mono items={x.topPaths.map((p) => ({ label: p.path || '/', count: p.count }))} />
                <RankList title="Top countries" items={x.topCountries.map((p) => ({ label: p.country, count: p.count }))} />
                <RankList title="Top networks" items={x.topAsns.map((p) => ({ label: p.name || `AS${p.asn}`, sub: `AS${p.asn}`, count: p.count }))} />
              </div>
            ) : <p className="text-xs text-muted">Cloudflare returned no path, country or network breakdown for this rule in the window.</p>}
            {x.passthrough && <LetThrough p={x.passthrough} />}
          </td>
        </tr>
      )}
    </>
  );
}

const VERDICT_TONE: Record<PassThrough['verdict'], 'bad' | 'warn' | 'ok' | 'neutral'> = { malicious: 'bad', bots: 'warn', clean: 'ok', too_few: 'neutral' };
const VERDICT_TEXT: Record<PassThrough['verdict'], string> = { malicious: 'Lets malicious requests through', bots: 'Lets too many bots through', clean: 'Clean', too_few: 'Too few requests to judge' };

/** What a rule let through (log, skip, allow, solved challenges): its make-up and the recommendation. */
function LetThrough({ p }: { p: PassThrough }) {
  const st = p.statuses;
  return (
    <div className="mt-3 rounded-lg border border-line bg-surface/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Traffic it let through</h4>
        <Badge tone={VERDICT_TONE[p.verdict]}>{VERDICT_TEXT[p.verdict]}</Badge>
        <span className="text-xs text-muted">{p.kinds.map((k) => PASS_LABEL[k]).join(' · ')}</span>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-muted">Passed</dt><dd className="tabular-nums text-ink">{whole.format(p.passed)}</dd></div>
        <div><dt className="text-muted">Automated</dt><dd className="tabular-nums text-ink">{whole.format(p.bots)} <span className="text-muted">({pct(p.botShare)}, {p.botBasis === 'score' ? 'bot score' : 'user agents — a heuristic'})</span></dd></div>
        <div><dt className="text-muted">Malicious</dt><dd className="tabular-nums text-ink">{whole.format(p.malicious)} <span className="text-muted">({pct(p.maliciousShare)}, {p.maliciousBasis === 'attack_score' ? 'attack score' : 'threat paths / repeat offenders — a heuristic'})</span></dd></div>
        <div><dt className="text-muted">Login, account, admin or API paths</dt><dd className="tabular-nums text-ink">{whole.format(p.sensitiveHits)}</dd></div>
        <div><dt className="text-muted">From hosting networks</dt><dd className="tabular-nums text-ink">{p.topAsns.length ? pct(p.hostingShare) : <span className="text-faint">no network data</span>}</dd></div>
        <div><dt className="text-muted">Browser user agents</dt><dd className="tabular-nums text-ink">{p.topUas.length ? pct(p.browserShare) : <span className="text-faint">no user-agent data</span>}</dd></div>
        {st && st.s2xx + st.s4xx + st.s5xx > 0 && <div><dt className="text-muted">Responses 2xx · 4xx · 5xx</dt><dd className="tabular-nums text-ink">{whole.format(st.s2xx)} · {whole.format(st.s4xx)} · {whole.format(st.s5xx)}</dd></div>}
        {!!p.peakPerHour && <div><dt className="text-muted">Busiest hour</dt><dd className="tabular-nums text-ink">{whole.format(p.peakPerHour)}</dd></div>}
        {p.solveRate !== null && <div><dt className="text-muted">Challenge solve rate</dt><dd className="tabular-nums text-ink">{pct(p.solveRate)}</dd></div>}
      </dl>
      {p.topPaths.length + p.topAsns.length + p.topUas.length > 0 && <div className="mt-4 grid gap-5 md:grid-cols-3">
        {p.topPaths.length > 0 && <RankList title="Paths it let through" mono items={p.topPaths.map((x) => ({ label: x.path || '/', count: x.count }))} />}
        {p.topAsns.length > 0 && <RankList title="Networks" items={p.topAsns.map((a) => ({ label: a.name || `AS${a.asn}`, sub: `AS${a.asn} · ${a.hosting ? 'hosting' : 'consumer'}`, count: a.count }))} />}
        {p.topUas.length > 0 && <RankList title="User agents" mono items={p.topUas.map((u) => ({ label: u.ua || '(none)', sub: u.browser ? 'browser' : 'not a browser', count: u.count }))} />}
      </div>}
      <RecommendationBox r={p.recommendation} />
    </div>
  );
}

const ACTION_TONE: Record<Recommendation['action'], 'bad' | 'warn' | 'ok' | 'neutral' | 'info'> = { block_or_challenge: 'bad', narrow: 'bad', replace_allow: 'bad', rate_limit: 'warn', keep: 'ok', no_conclusion: 'neutral' };
const ACTION_TEXT: Record<Recommendation['action'], string> = { block_or_challenge: 'Change the action', narrow: 'Narrow the rule', replace_allow: 'Replace the allow rule', rate_limit: 'Add a rate limit', keep: 'No action', no_conclusion: 'No conclusion' };

function RecommendationBox({ r }: { r: Recommendation }) {
  return (
    <div className="mt-4 border-t border-line pt-3 text-[12.5px] text-ink-2">
      <div className="flex flex-wrap items-center gap-2"><Badge tone={ACTION_TONE[r.action]}>{ACTION_TEXT[r.action]}</Badge><span className="font-medium text-ink">{r.title}</span></div>
      <ol className="mt-2 list-decimal space-y-1 pl-5">{r.steps.map((x, i) => <li key={i} className="break-words">{x}</li>)}</ol>
      {r.expression && <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-sunken/60 px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap break-all">{r.expression}</pre>}
      <p className="mt-1 text-[11px] text-faint">Not applied — make the change in the dashboard.</p>
    </div>
  );
}

/** The ranked action list: traffic recommendations and the fixes of confirmed high and critical findings; each links to its finding or rule. */
export function RecommendedActions({ items, e }: { items: ActionItem[]; e: Effectiveness | null }) {
  const nav = useContext(AuditNav);
  const kept = (e?.recommendations ?? []).filter((x) => x.action === 'keep' || x.action === 'no_conclusion');
  return (
    <Card>
      <SectionHeader title="Recommended actions" description={`${items.length} changes, most important first: what the traffic says about rules that let requests through, and the fix of every confirmed high or critical finding. Nothing is applied.`} />
      {!items.length ? <p className="px-5 py-4 text-[13px] text-muted">Nothing to change in what was read{kept.length ? `; ${kept.length} rules that let traffic through can stay as they are (see Effectiveness)` : ''}.</p> : (
        <ol className="divide-y divide-line/70">
          {items.map((x, i) => (
            <li key={`${x.fingerprint ?? x.ruleKey ?? x.title}:${i}`} className="px-5 py-3">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="tabular-nums text-xs text-faint">{i + 1}.</span>
                {x.severity && <SeverityBadge s={x.severity} />}
                <Badge tone={x.action === 'fix' ? 'info' : ACTION_TONE[x.action]}>{x.action === 'fix' ? 'Fix the finding' : ACTION_TEXT[x.action]}</Badge>
                <span className="font-medium text-ink">{x.title}</span>
                {x.impact > 0 && <span className="text-xs tabular-nums text-muted">{whole.format(x.impact)} requests in the window</span>}
              </div>
              <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
                <span>{x.source === 'traffic' ? 'From traffic' : 'From configuration'} · {x.ruleName}</span>
                {x.fingerprint && <button type="button" className="text-signal hover:underline" onClick={() => nav.finding(x.fingerprint!)}>Finding and evidence</button>}
                {x.ruleKey && <button type="button" className="text-signal hover:underline" onClick={() => nav.effect(x.ruleKey!)}>Its traffic</button>}
              </p>
              <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-[12.5px] text-ink-2">{x.steps.map((st, k) => <li key={k} className="break-words">{st}</li>)}</ol>
              {x.expression && <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-sunken/60 px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap break-all">{x.expression}</pre>}
            </li>
          ))}
        </ol>
      )}
      {e && e.notAnalysed.length > 0 && <p className="border-t border-line px-5 py-3 text-xs text-muted">Not analysed ({e.notAnalysed.length}): {e.notAnalysed.slice(0, 10).map((x) => `${x.ruleName} (${whole.format(x.passed)})`).join(', ')}{e.notAnalysed.length > 10 ? ', …' : ''} — {e.notAnalysed[0].reason}.</p>}
    </Card>
  );
}

const SET_TONE: Record<ManagedOverview['rulesets'][number]['state'], 'ok' | 'bad' | 'warn' | 'neutral'> = { deployed: 'ok', disabled: 'bad', not_deployed: 'warn', not_applicable: 'neutral', not_read: 'warn' };
const SET_TEXT: Record<ManagedOverview['rulesets'][number]['state'], string> = { deployed: 'Deployed', disabled: 'Disabled', not_deployed: 'Not deployed', not_applicable: 'Not on this plan', not_read: 'Not read' };

/** The Managed Ruleset tab's overview: each ruleset's state, overrides, OWASP tuning and events; then the exceptions with their traffic. */
export function ManagedOverviewCard({ m }: { m: ManagedOverview }) {
  const nav = useContext(AuditNav);
  return (
    <Card>
      <SectionHeader title="Managed rulesets" description={`Deployment, scope and overrides from the configuration; what each did from the security events. Leaked credentials detection: ${m.leakedCredentials === 'on' ? 'on' : m.leakedCredentials === 'off' ? 'off' : 'not read'}.`} />
      <ul className="divide-y divide-line/70">
        {m.rulesets.map((r) => (
          <li key={r.id} className="px-5 py-3 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{r.name}</span><Badge tone={SET_TONE[r.state]}>{SET_TEXT[r.state]}</Badge>
              {r.scope && r.state !== 'not_applicable' && <span className="font-mono text-[11.5px] text-muted">scope: {r.scope === 'true' ? 'all traffic' : r.scope}</span>}
              {r.action && <Badge tone="warn">ruleset action {r.action}</Badge>}
              {r.threshold !== undefined && <span className="text-xs text-muted">paranoia {r.paranoia === null ? 'PL1 (default)' : `PL${r.paranoia}`} · score threshold {r.threshold}</span>}
            </div>
            {r.reason && <p className="mt-0.5 text-xs text-muted">{r.reason}</p>}
            {r.overrides.length > 0 && <p className="mt-1 text-xs text-ink-2">Overrides: {r.overrides.map((o) => `${o.kind} ${o.id} — ${o.change}`).join('; ')}</p>}
            {r.events && r.events.total > 0 && (
              <div className="mt-2 grid gap-4 md:grid-cols-[minmax(0,14rem)_1fr]">
                <div className="text-xs text-ink-2"><div className="tabular-nums text-ink">{whole.format(r.events.total)} events</div>{Object.entries(r.events.byAction).sort((a, b) => b[1] - a[1]).map(([a, c]) => <div key={a}>{a.replace(/_/g, ' ')} <span className="tabular-nums text-muted">{whole.format(c)}</span></div>)}</div>
                <RankList title="Top rules firing" mono items={r.events.topRules.map((x) => ({ label: x.description || x.ruleId, sub: `${x.ruleId}${x.logOnly ? ' · log only' : ''}`, count: x.total }))} />
              </div>
            )}
            {r.events && !r.events.total && r.state === 'deployed' && <p className="mt-1 text-xs text-muted">No events in the window.</p>}
          </li>
        ))}
      </ul>
      <div className="border-t border-line px-5 py-3">
        <h4 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Exceptions (skip rules), in order</h4>
        {!m.exceptions.length ? <p className="text-xs text-muted">No managed-rule exceptions.</p> : (
          <ol className="space-y-2 text-[12.5px]">
            {m.exceptions.map((x) => (
              <li key={x.id} className="rounded-md border border-line px-3 py-2">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-ink">{x.name}</span>
                  {!x.enabled && <Badge tone="neutral">disabled</Badge>}{x.position === 'after' && <Badge tone="warn">after the deploy rules — no effect</Badge>}
                  <span className="text-xs text-muted">skips {x.skips}</span></div>
                <code className="mt-1 block font-mono text-[11.5px] break-all text-ink-2">{x.expression || '(no expression)'}</code>
                <p className="mt-1 text-xs text-muted">{x.skipped === null ? 'Traffic not read' : `${whole.format(x.skipped)} requests skipped in the window${x.verdict ? ` — ${VERDICT_TEXT[x.verdict].toLowerCase()}` : ''}`}
                  {x.effectKey && <> · <button type="button" className="text-signal hover:underline" onClick={() => nav.effect(x.effectKey!)}>its traffic</button></>}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
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
