// Cross-checks of an audit report: every count recomputed a second way and compared. Pure.
// With the snapshot (when the report is built), traffic totals are also recomputed from the raw
// analytics rows and every finding's evidence is checked against the reads; without it (an audit
// stored before these checks), the checks that only need the report run. A failed check is shown
// on the report; it means a number on the page cannot be trusted as is.

import { AREAS, GRADES, penaltyOf, postureOf } from './posture';
import { COVERAGE_STATES, SEVERITIES, type AuditReport, type EventData, type Snapshot, type VerificationCheck } from './types';
import { compactNum } from '../num';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

export function verifyReport(r: AuditReport, s?: Snapshot): VerificationCheck[] {
  const out: VerificationCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string) => out.push({ id, label, ok, detail });

  // Counts in the summary.
  const bad = SEVERITIES.filter((v) => r.summary.bySeverity[v] !== r.findings.filter((f) => f.severity === v).length);
  add('summary.severity', 'Findings by severity add up', !bad.length, bad.length ? `Different for ${bad.join(', ')}` : `${r.findings.length} findings: ${SEVERITIES.map((v) => `${r.summary.bySeverity[v]} ${v}`).join(', ')}`);
  const conf = r.findings.filter((f) => f.verdict === 'confirmed').length;
  add('summary.verdict', 'Confirmed and needs-validation counts add up', r.summary.byVerdict.confirmed === conf && r.summary.byVerdict.needs_validation === r.findings.length - conf,
    `${conf} confirmed + ${r.findings.length - conf} need validation = ${r.findings.length}`);
  const states = COVERAGE_STATES.filter((st) => r.summary.coverage[st] !== r.coverage.filter((c) => c.state === st).length);
  add('summary.coverage', 'Coverage ledger counts add up', !states.length && r.summary.rules === r.coverage.length, states.length ? `Different for ${states.join(', ')}` : `${r.coverage.length} checks: ${COVERAGE_STATES.map((st) => `${r.summary.coverage[st]} ${st.replace('_', ' ')}`).join(', ')}`);
  const perRule = r.coverage.filter((c) => c.findings !== r.findings.filter((f) => f.ruleId === c.ruleId).length);
  const orphan = r.findings.filter((f) => !r.coverage.some((c) => c.ruleId === f.ruleId && c.state === 'finding'));
  add('coverage.findings', 'Each check\'s finding count matches its findings', !perRule.length && !orphan.length, perRule.length || orphan.length ? `Mismatch: ${[...perRule.map((c) => c.ruleId), ...orphan.map((f) => f.ruleId)].slice(0, 5).join(', ')}` : 'Every finding belongs to a check marked “finding”, and the counts agree');

  // Each finding is complete.
  const incomplete = r.findings.filter((f) => !f.evidence.length || !f.fix.length || (f.verdict === 'needs_validation') !== !!f.validation);
  add('findings.complete', 'Every finding has evidence, a fix, and (when it needs validation) the check that settles it', !incomplete.length, incomplete.length ? incomplete.slice(0, 5).map((f) => f.ruleId).join(', ') : `${r.findings.length} of ${r.findings.length} complete`);

  // Evidence checked against Cloudflare's answers.
  const ev = r.findings.flatMap((f) => f.evidence);
  if (ev.some((e) => e.check)) {
    const n = (c: string) => ev.filter((e) => e.check === c).length;
    add('evidence.checked', 'Every evidence value was checked against the reads', ev.every((e) => e.check), `${n('matches')} found as shown in Cloudflare's answer, ${n('computed')} worked out from it, ${n('traffic')} counted from analytics`);
  }
  if (s) {
    const unread = ev.filter((e) => e.key && s.reads[e.key]?.state !== 'ok');
    add('evidence.sources_read', 'Every source a finding cites was read successfully', !unread.length, unread.length ? `Not read: ${[...new Set(unread.map((e) => e.key))].join(', ')}` : `${new Set(ev.map((e) => e.key).filter(Boolean)).size} sources cited, all read`);
  }

  // Rule effectiveness.
  const e = r.effectiveness;
  if (e) {
    const sums = e.rules.filter((x) => !near(Object.values(x.byAction).reduce((a, b) => a + b, 0), x.events));
    add('effect.by_action', 'Each rule\'s events equal the sum of its actions', !sums.length, sums.length ? sums.slice(0, 5).map((x) => x.name).join(', ') : `${e.rules.length} rules`);
    const ch = e.rules.filter((x) => x.solveRate !== null && !near(x.solveRate, x.solved / x.challenged));
    add('effect.solve_rate', 'Solve rates equal solved ÷ challenged', !ch.length, ch.length ? ch.slice(0, 5).map((x) => x.name).join(', ') : 'All solve rates recomputed');
    const pt = e.rules.filter((x) => x.passthrough && (x.passthrough.bots > x.passthrough.passed || x.passthrough.malicious > x.passthrough.passed
      || (x.passthrough.passed > 0 && (!near(x.passthrough.botShare, Math.min(1, x.passthrough.bots / x.passthrough.passed)) || !near(x.passthrough.maliciousShare, Math.min(1, x.passthrough.malicious / x.passthrough.passed))))));
    add('effect.passthrough', 'Traffic let through: bot and malicious counts fit inside what passed, and the shares are their ratios', !pt.length, pt.length ? pt.slice(0, 5).map((x) => x.name).join(', ') : `${e.rules.filter((x) => x.passthrough).length} rules analysed`);
    const imp = e.recommendations.filter((x) => { const row = e.rules.find((y) => y.key === x.ruleKey); return !row?.passthrough || x.impact > row.passthrough.passed; });
    add('effect.impact', 'Each recommendation\'s request count comes from its rule\'s traffic', !imp.length, imp.length ? imp.slice(0, 5).map((x) => x.ruleName).join(', ') : `${e.recommendations.length} recommendations`);
    const shown = e.rules.reduce((a, x) => a + x.events, 0);
    add('effect.total_bound', 'Rules listed account for no more than the total events', shown <= e.totalEvents, `${compactNum(shown)} on the listed rules of ${compactNum(e.totalEvents)} in all`);
    if (s?.reads.events?.state === 'ok') {
      const raw = (s.reads.events.value as EventData).rules.reduce((a, x) => a + x.count, 0);
      add('effect.total_raw', 'Total security events equal the sum of the raw analytics rows', raw === e.totalEvents, `${compactNum(raw)} in ${(s.reads.events.value as EventData).rules.length} rows; report says ${compactNum(e.totalEvents)}`);
    }
  }
  for (const m of r.managed?.rulesets ?? []) {
    if (!m.events) continue;
    const t = Object.values(m.events.byAction).reduce((a, b) => a + b, 0);
    if (t !== m.events.total) add(`managed.${m.id}`, `${m.name}: events equal the sum of their actions`, false, `${t} vs ${m.events.total}`);
  }

  // Posture, recomputed from its own proof.
  const p = postureOf(r);
  const areaBad = p.areas.filter((a) => a.score !== null && a.score !== Math.max(0, Math.round(100 - a.penalties.reduce((x, y) => x + y.points, 0))));
  const penBad = p.areas.flatMap((a) => a.penalties).filter((x) => { const f = r.findings.find((y) => y.fingerprint === x.fingerprint); return !f || penaltyOf(f) !== x.points; });
  add('posture.areas', 'Each area score is 100 minus its findings\' points', !areaBad.length && !penBad.length, areaBad.length ? areaBad.map((a) => a.label).join(', ') : `${p.areas.filter((a) => a.score !== null).length} areas graded`);
  const inArea = r.findings.filter((f) => !AREAS.some((a) => a.groups.includes(f.group)));
  add('posture.every_finding_counted', 'Every finding is counted in exactly one area', !inArea.length, inArea.length ? inArea.map((f) => f.ruleId).join(', ') : `${r.findings.length} findings`);
  if (p.score !== null && p.gradeProof.mean !== null) {
    const w = p.gradeProof.rows.reduce((a, x) => a + x.weight, 0);
    const mean = Math.round(p.gradeProof.rows.reduce((a, x) => a + x.score * x.weight, 0) / w);
    const g = GRADES.find((x) => p.score! >= x.min)!.grade;
    add('posture.grade', 'The grade follows from the weighted mean and the caps', mean === p.gradeProof.mean && p.score <= mean && g === p.grade && (p.score === mean || !!p.gradeProof.cap),
      `Weighted mean ${mean}${p.gradeProof.cap ? `, capped to ${p.score}` : ''} → ${p.grade}`);
    if (r.summary.grade !== undefined) add('posture.stored', 'The stored grade equals the recomputed one', r.summary.grade === p.grade && r.summary.score === p.score, `Stored ${r.summary.grade ?? '—'} ${r.summary.score ?? ''}, recomputed ${p.grade ?? '—'} ${p.score ?? ''}`);
  }
  const en = p.enforcement;
  if (en.proof && en.enforcedShare !== null) {
    const a = Object.values(en.proof.enforcedByAction).reduce((x, y) => x + y, 0), b = Object.values(en.proof.passiveByAction).reduce((x, y) => x + y, 0);
    add('posture.enforced', 'Blocked-or-challenged share equals its counts', near(en.enforcedShare, a / (a + b)), `${compactNum(a)} ÷ (${compactNum(a)} + ${compactNum(b)}) = ${Math.round((a / (a + b)) * 100)}%`);
  }
  return out;
}
