'use client';

import { useContext, useMemo, type ReactNode } from 'react';
import { SeverityBadge } from '@/components/monitor-view';
import { Badge, Card, SectionHeader, Stat, cx } from '@/components/ui';
import { whole } from '@/lib/num';
import { PENALTY, RATING_LABEL, THREAT_LABEL, postureOf, type Rating, type Step, type ThreatStatus } from '@/lib/zone-audit/posture';
import { verifyReport } from '@/lib/zone-audit/verify';
import { COVERAGE_LABEL, type AuditReport } from '@/lib/zone-audit/types';
import { AuditNav } from './audit-view';

// The Posture tab of the audit report: the grade and verdict, the area scorecard, enforcement in the
// traffic, threat coverage, next steps by urgency, what the gaps cost to close, and what to watch.
// Everything comes from postureOf(report); links open the finding in the Findings tab.

const pct = (x: number) => `${Math.round(x * 100)}%`;
/** A share, or "Not measured" — never 0% for something that was not read. */
const share = (x: number | null) => (x === null ? 'Not measured' : pct(x));
const RATING_TONE: Record<Rating, 'ok' | 'warn' | 'bad' | 'neutral' | 'info'> = { strong: 'ok', fair: 'info', weak: 'warn', at_risk: 'bad', unknown: 'neutral', not_applicable: 'neutral' };
const THREAT_TONE: Record<ThreatStatus, 'ok' | 'warn' | 'bad' | 'neutral'> = { covered: 'ok', partial: 'warn', gap: 'bad', unknown: 'neutral', not_applicable: 'neutral' };
const gradeTone = (g: string | null) => (g === 'A' || g === 'B' ? 'text-ok' : g === 'C' ? 'text-warn' : g ? 'text-bad' : 'text-muted');

function FindingLink({ fp, children }: { fp: string; children: ReactNode }) {
  const nav = useContext(AuditNav);
  return <button type="button" className="text-left text-ink-2 hover:text-signal hover:underline" onClick={() => nav.finding(fp)}>{children}</button>;
}

/** "How this was worked out": the inputs and the arithmetic behind a number. */
function HowWorkedOut({ children, label = 'How this was worked out' }: { children: ReactNode; label?: string }) {
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-signal">{label}</summary>
      <div className="mt-1.5 space-y-1 rounded-md bg-sunken/60 px-3 py-2 text-ink-2">{children}</div>
    </details>
  );
}
const counts = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace(/_/g, ' ')} ${whole.format(v)}`).join(' + ') || 'none';

function StepList({ title, hint, steps }: { title: string; hint: string; steps: Step[] }) {
  return (
    <div className="min-w-0">
      <h4 className="text-[13px] font-medium text-ink">{title}</h4>
      <p className="mb-2 text-xs text-muted">{hint}</p>
      {!steps.length ? <p className="text-xs text-faint">Nothing here.</p> : (
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li key={`${s.fingerprint ?? s.title}:${i}`} className="text-[12.5px]">
              <div className="flex items-start gap-2">{s.severity && <SeverityBadge s={s.severity} />}{s.fingerprint ? <FindingLink fp={s.fingerprint}>{s.title}</FindingLink> : <span className="text-ink">{s.title}</span>}</div>
              {s.detail && <p className="mt-0.5 break-words text-xs text-muted">{s.detail}</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function PostureView({ r }: { r: AuditReport }) {
  const p = useMemo(() => postureOf(r), [r]);
  const en = p.enforcement;
  const areas = p.areas.filter((a) => a.rating !== 'not_applicable');
  const threats = p.threats.filter((t) => t.status !== 'not_applicable');
  const checks = useMemo(() => r.verification ?? verifyReport(r), [r]);
  const failed = checks.filter((c) => !c.ok);
  const pr = en.proof;
  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center" data-testid="posture-verdict">
          <div className="flex shrink-0 items-baseline gap-3">
            <span className={cx('text-[56px] leading-none font-semibold tracking-[-0.03em]', gradeTone(p.grade))} aria-label={`Grade ${p.grade ?? 'not graded'}`}>{p.grade ?? '—'}</span>
            <span className="text-[13px] text-muted"><span className="block font-medium text-ink">{p.label}</span>{p.score !== null && <span className="tabular-nums">{p.score} / 100</span>}</span>
          </div>
          <p className="text-[13.5px] leading-relaxed text-ink-2">{p.verdict}</p>
        </div>
        <div className="border-t border-line px-5 pb-3">
          <HowWorkedOut label="How the grade was worked out">
            {p.gradeProof.rows.length ? <>
              <p>Weighted mean of the graded areas = Σ (score × weight) ÷ Σ weight:</p>
              <ul className="list-disc pl-5">{p.gradeProof.rows.map((x) => <li key={x.area}>{x.area}: {x.score} × {x.weight} = {x.score * x.weight}</li>)}</ul>
              <p>= {p.gradeProof.rows.reduce((a, x) => a + x.score * x.weight, 0)} ÷ {p.gradeProof.rows.reduce((a, x) => a + x.weight, 0)} = <strong>{p.gradeProof.mean}</strong>{p.gradeProof.cap ? <> — {p.gradeProof.cap}</> : null}</p>
              <p>Grade floors: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 55, else F. Score {p.score} → <strong>{p.grade}</strong>.</p>
            </> : <p>No area had at least half of its checks read, so there is no grade.</p>}
            {p.areas.some((a) => a.rating === 'unknown') && <p>Not graded (less than half of their checks read): {p.areas.filter((a) => a.rating === 'unknown').map((a) => `${a.label} (${a.read} of ${a.applicable})`).join(', ')}.</p>}
          </HowWorkedOut>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Scorecard" description="Each area's checks. A finding costs points by severity, half when it needs validation. Areas with less than half of their checks read are not graded." />
        <ul className="grid gap-px bg-line/70 sm:grid-cols-2 lg:grid-cols-3">
          {areas.map((a) => (
            <li key={a.id} className="bg-surface px-5 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-ink" title={a.what}>{a.label}</span>
                <Badge tone={RATING_TONE[a.rating]}>{RATING_LABEL[a.rating]}{a.score !== null ? ` · ${a.score}` : ''}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted">{a.read} of {a.applicable} checks read · {a.findings ? `${a.findings} finding${a.findings === 1 ? '' : 's'}` : 'no findings'}</p>
              {a.top ? <div className="mt-1.5 flex items-start gap-1.5 text-xs"><SeverityBadge s={a.top.severity} /><FindingLink fp={a.top.fingerprint}>{a.top.title}</FindingLink></div>
                : a.good[0] ? <p className="mt-1.5 text-xs text-ok">{a.good[0]}</p> : null}
              {a.score !== null && (
                <HowWorkedOut>
                  {a.penalties.length ? <>
                    <p>100 minus each finding&apos;s points (critical {PENALTY.critical}, high {PENALTY.high}, medium {PENALTY.medium}, low {PENALTY.low}; half when it needs validation):</p>
                    <ul className="list-disc pl-5">{a.penalties.map((x) => <li key={x.fingerprint}>−{x.points} · {x.severity}{x.verdict === 'needs_validation' ? ' (needs validation)' : ''}: <FindingLink fp={x.fingerprint}>{x.title}</FindingLink></li>)}</ul>
                    <p>= 100 − {a.penalties.reduce((t, x) => t + x.points, 0)} = <strong>{a.score}</strong> (never below 0)</p>
                  </> : <p>No findings: 100. {a.passed} of {a.read} checks read passed.</p>}
                </HowWorkedOut>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <SectionHeader title="Enforcement in the traffic" description="What the security rules did to the window's requests. “Not measured” means it could not be read; it is never shown as 0%." />
        <div className="grid gap-3 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
          <Stat label="Security events" value={en.events === null ? '—' : whole.format(en.events)} sub={en.trend === null ? 'No earlier window to compare' : `${en.trend > 0 ? '+' : ''}${pct(en.trend)} against the window before`} />
          <Stat label="Blocked or challenged" value={share(en.enforcedShare)} sub="Of the events that ended in a decision" tone={en.enforcedShare === null ? undefined : en.enforcedShare >= 0.8 ? 'ok' : en.enforcedShare >= 0.5 ? 'warn' : 'bad'} />
          <Stat label="WAF matches only logged" value={share(en.logOnlyShare)} sub={en.logOnlyShare === 0 ? 'No log-only evidence (not proof that every rule enforces)' : 'Managed and custom rule matches in Log mode'} tone={en.logOnlyShare === null ? undefined : en.logOnlyShare > 0.2 ? 'warn' : 'ok'} />
          <Stat label="Challenge solve rate" value={share(en.solveRate)} sub="A high rate means people are being challenged" />
          <Stat label="Bad traffic let through" value={en.badLetThrough === null ? 'Not measured' : whole.format(en.badLetThrough)} sub="Bot or malicious requests passed by log, skip or allow rules" tone={en.badLetThrough ? 'bad' : en.badLetThrough === 0 ? 'ok' : undefined} />
          <Stat label="Rules with no match" value={en.silent === null ? '—' : `${en.silent} of ${en.configured}`} sub="Enabled rules that matched nothing in the window" />
        </div>
        {pr && (
          <div className="border-t border-line px-5 pb-3">
            <HowWorkedOut label="How these numbers were worked out">
              <p>All from the security events of the window (GraphQL firewallEventsAdaptiveGroups, grouped by rule and action; the queries are listed under Coverage › Analytics queries).</p>
              <p><strong>Security events</strong> = the sum of every rule&apos;s events = {en.events === null ? '—' : whole.format(en.events)}.{pr.previous !== null ? ` Window before: ${whole.format(pr.previous)}${en.trend !== null ? ` → (${whole.format(en.events ?? 0)} − ${whole.format(pr.previous)}) ÷ ${whole.format(pr.previous)} = ${en.trend > 0 ? '+' : ''}${pct(en.trend)}` : ''}.` : ''}</p>
              <p><strong>Blocked or challenged</strong> = blocking and challenge actions ({counts(pr.enforcedByAction)}) ÷ those plus the actions that let the request on ({counts(pr.passiveByAction)}) = {share(en.enforcedShare)}. Solved challenges and other outcomes are left out of both.</p>
              <p><strong>WAF matches only logged</strong> = managed and custom rule matches with the action Log ({whole.format(pr.wafLogged)}) ÷ all their decided matches ({whole.format(pr.wafDecided)}) = {share(en.logOnlyShare)}.</p>
              <p><strong>Challenge solve rate</strong> = solved ({whole.format(pr.solved)}) ÷ challenges issued ({whole.format(pr.challenged)}){pr.challenged < 10 ? ' — fewer than 10 issued, so not measured' : ` = ${share(en.solveRate)}`}.</p>
              <p><strong>Bad traffic let through</strong> = bot + malicious requests counted on the rules that log, skip or allow{pr.badByRule.length ? ':' : ' — none found.'}</p>
              {pr.badByRule.length > 0 && <ul className="list-disc pl-5">{pr.badByRule.slice(0, 10).map((x) => <li key={x.rule}>{x.rule}: {whole.format(x.bots)} bots + {whole.format(x.malicious)} malicious</li>)}</ul>}
              <p><strong>Rules with no match</strong>: {pr.silentRules.length ? pr.silentRules.slice(0, 15).join(', ') : 'none'}.</p>
            </HowWorkedOut>
          </div>
        )}
      </Card>

      <Card>
        <SectionHeader title="Threat coverage" description="The attack types a zone audit can judge: what is in place against each, and the gaps. Open a gap for its evidence and fix." />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead className="border-b border-line text-xs text-muted"><tr><th scope="col" className="px-5 py-2 font-medium">Threat</th><th scope="col" className="px-3 py-2 font-medium">Status</th><th scope="col" className="px-3 py-2 font-medium">In place</th><th scope="col" className="px-5 py-2 font-medium">Gaps and what to do</th></tr></thead>
            <tbody className="divide-y divide-line/70">
              {threats.map((t) => (
                <tr key={t.id} className="align-top">
                  <td className="px-5 py-2 text-ink">{t.label}</td>
                  <td className="px-3 py-2"><Badge tone={THREAT_TONE[t.status]}>{THREAT_LABEL[t.status]}</Badge>
                    <HowWorkedOut label="Why">
                      <ul className="space-y-0.5">{t.checks.map((c) => <li key={c.ruleId}><code className="font-mono text-[11px]">{c.ruleId}</code>: {COVERAGE_LABEL[c.state]}{c.findings ? ` (${c.findings})` : ''}</li>)}</ul>
                      <p className="mt-1 text-muted">Gap: a confirmed high or critical finding. Partly covered: a medium or worse finding. Covered: the rest. Not read: none of the checks could be read.</p>
                    </HowWorkedOut></td>
                  <td className="px-3 py-2 text-xs text-ink-2">{t.controls.length ? <ul className="space-y-0.5">{t.controls.map((c, i) => <li key={i}>{c}</li>)}</ul> : <span className="text-faint">—</span>}</td>
                  <td className="px-5 py-2 text-xs">
                    {t.gaps.length > 0 && <ul className="space-y-0.5">{t.gaps.map((g) => <li key={g.fingerprint}><FindingLink fp={g.fingerprint}>{g.title}</FindingLink></li>)}</ul>}
                    {t.playbook.length > 0 && <p className="mt-1 text-muted">{t.playbook.join(' ')}</p>}
                    {!t.gaps.length && !t.playbook.length && <span className="text-faint">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Next steps" description={`By urgency. Nothing is applied: make each change in the dashboard.${p.steps.more ? ` ${p.steps.more} more are in Findings.` : ''}`} />
        <div className="grid gap-6 px-5 py-4 lg:grid-cols-3">
          <StepList title="Immediate" hint="Confirmed critical and high findings." steps={p.steps.immediate} />
          <StepList title="Short term" hint="High findings to validate, confirmed medium ones, and what the traffic says to change." steps={p.steps.shortTerm} />
          <StepList title="Hardening" hint="The remaining medium and low findings." steps={p.steps.hardening} />
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <SectionHeader title="Cost of closing the gaps" description={`On the ${r.zone.plan || 'current'} plan.`} />
          <div className="space-y-3 px-5 py-4 text-[13px]">
            <div><h4 className="mb-1 text-xs font-medium text-muted">No cost, on any plan</h4>
              {p.noCost.length ? <ul className="space-y-0.5">{p.noCost.map((x) => <li key={x.fingerprint}><FindingLink fp={x.fingerprint}>{x.title}</FindingLink></li>)}</ul> : <p className="text-xs text-faint">None open.</p>}</div>
            <div><h4 className="mb-1 text-xs font-medium text-muted">Plan upgrades that would close a gap</h4>
              {p.upgrades.length ? <ul className="space-y-1.5">{p.upgrades.map((u) => <li key={u.feature}><span className="text-ink">{u.feature}</span> <Badge tone="neutral">{u.plan}</Badge><span className="block text-xs text-muted">{u.why}</span></li>)}</ul> : <p className="text-xs text-faint">None needed for the gaps found.</p>}</div>
          </div>
        </Card>
        <Card>
          <SectionHeader title="What to monitor" description="After making the changes." />
          <ul className="list-disc space-y-1 py-4 pr-5 pl-9 text-[12.5px] text-ink-2">{p.monitor.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </Card>
      </div>

      <Card>
        <SectionHeader title="Verification" description={`Every count on this report recomputed a second way${r.verification ? ', and traffic totals from the raw analytics rows, when the report was built' : ' (this audit predates the checks made at build time: run it again for the full set)'}.`}
          aside={<Badge tone={failed.length ? 'bad' : 'ok'}>{failed.length ? `${failed.length} of ${checks.length} failed` : `${checks.length} of ${checks.length} hold`}</Badge>} />
        <ul className="divide-y divide-line/70 text-[12.5px]" data-testid="verification">
          {checks.map((c) => (
            <li key={c.id} className="flex items-start gap-3 px-5 py-2">
              <Badge tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'Holds' : 'Failed'}</Badge>
              <span className="min-w-0"><span className="text-ink">{c.label}</span><span className="block text-xs text-muted">{c.detail}</span></span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <SectionHeader title="Assumptions and limits" />
        <ul className="list-disc space-y-1 py-4 pr-5 pl-9 text-[12.5px] text-ink-2">{p.limits.map((m, i) => <li key={i}>{m}</li>)}</ul>
      </Card>
    </div>
  );
}
