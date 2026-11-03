// The audit report as files: findings.json (the finding records), REPORT.md, and CSV (findings,
// coverage or rule effectiveness). Pure — shared by the download route and the tests. Wording is
// target-neutral and every number comes from the report.

import { actionItems, findingRules } from './actions';
import { REF_LABEL, effectRef, refText, ruleIndex } from './rule-refs';
import { PENALTY, RATING_LABEL, THREAT_LABEL, postureOf } from './posture';
import { CHECK_LABEL, explain, reproduce } from './proof';
import { verifyReport } from './verify';
import { GROUP_LABEL, COVERAGE_LABEL, SEVERITIES, SEVERITY_LABEL, VERDICT_LABEL, windowLabel, type AuditFinding, type AuditReport } from './types';
import { compactNum } from '../num';

/** findings.json: the records, worst first, as stored. */
export const findingsJson = (r: AuditReport) => `${JSON.stringify(r.findings, null, 2)}\n`;

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // Spreadsheet formulas never run from a cell that starts with =, +, - or @.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

export type CsvPart = 'findings' | 'coverage' | 'effectiveness' | 'managed';
export const isCsvPart = (v: string): v is CsvPart => v === 'findings' || v === 'coverage' || v === 'effectiveness' || v === 'managed';

export function auditCsv(r: AuditReport, part: CsvPart): string {
  if (part === 'managed') return csv(['ruleset', 'id', 'state', 'reason', 'scope', 'ruleset_action', 'overrides', 'paranoia', 'threshold', 'events', 'by_action', 'top_rules'],
    (r.managed?.rulesets ?? []).map((x) => [x.name, x.id, x.state, x.reason ?? '', x.scope ?? '', x.action ?? '', x.overrides.map((o) => `${o.kind} ${o.id}: ${o.change}`).join('; '), x.paranoia ?? '', x.threshold ?? '',
      x.events?.total ?? '', x.events?.byAction ?? '', (x.events?.topRules ?? []).map((t) => `${t.ruleId} ${compactNum(t.total)}${t.logOnly ? ' (log only)' : ''}`).join('; ')]));
  if (part === 'coverage') return csv(['rule', 'title', 'group', 'state', 'findings', 'reason', 'permission', 'attack_class', 'skill_ref'],
    r.coverage.map((c) => [c.ruleId, c.title, GROUP_LABEL[c.group], c.state, c.findings, c.reason ?? '', c.permission ?? '', c.attackClass, c.skillRef]));
  if (part === 'effectiveness') return csv(['kind', 'rule', 'ruleset', 'source', 'name', 'configured', 'config_action', 'events', 'by_action', 'challenged', 'solved', 'solve_rate', 'previous', 'trend', 'top_paths', 'top_countries', 'top_networks', 'passed', 'passed_bots', 'bot_basis', 'passed_malicious', 'malicious_basis', 'verdict', 'recommendation'],
    (r.effectiveness?.rules ?? []).map((x) => [REF_LABEL[effectRef(x).kind], x.ruleId, x.rulesetId, x.source, x.name, x.configured, x.configAction ?? '', x.events, x.byAction, x.challenged, x.solved,
      x.solveRate === null ? '' : x.solveRate.toFixed(3), x.previous ?? '', x.trend === null ? '' : x.trend.toFixed(3),
      x.topPaths.map((p) => `${p.path} (${compactNum(p.count)})`).join('; '), x.topCountries.map((p) => `${p.country} (${compactNum(p.count)})`).join('; '), x.topAsns.map((p) => `AS${p.asn} ${p.name} (${compactNum(p.count)})`).join('; '),
      x.passthrough?.passed ?? '', x.passthrough?.bots ?? '', x.passthrough?.botBasis ?? '', x.passthrough?.malicious ?? '', x.passthrough?.maliciousBasis ?? '', x.passthrough?.verdict ?? '', x.passthrough?.recommendation.title ?? '']));
  const idx = ruleIndex(null, r.effectiveness);
  return csv(['severity', 'verdict', 'rule', 'group', 'title', 'applies_to', 'attack_class', 'skill_ref', 'description', 'root_cause', 'evidence', 'fix', 'validation', 'fingerprint'],
    r.findings.map((f) => [f.severity, f.verdict, f.ruleId, GROUP_LABEL[f.group], f.title, findingRules(f, r, idx).map(refText).join('; '), f.attackClass, f.skillRef, f.description, f.rootCause,
      f.evidence.map((e) => `${e.source} ${e.field} = ${e.value}${e.check ? ` [${e.check}]` : ''}`).join(' | '), f.fix.join(' | '), f.validation ?? '', f.fingerprint]));
}

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** REPORT.md, in the page's order: summary, posture, findings, recommended actions, effectiveness, managed ruleset, coverage ledger, method. */
export function auditMarkdown(r: AuditReport, brand: string): string {
  const s = r.summary;
  const idx = ruleIndex(null, r.effectiveness);
  const byFp = new Map(r.findings.map((f) => [f.fingerprint, f]));
  /** " · applies to Custom rule “Watch API”" for a finding that is about rules, else nothing. */
  const appliesTo = (f: AuditFinding | undefined) => { const refs = f ? findingRules(f, r, idx) : []; return refs.length ? ` · applies to ${refs.map(refText).join(', ')}` : ''; };
  const L: string[] = [];
  const tick = (v: string) => `\`${v.replace(/`/g, "'")}\``;
  L.push(`# Security audit — ${r.zone.name}`, '');
  L.push(`Zone ID \`${r.zone.id}\` · account ${r.zone.accountName || r.zone.accountId} · plan ${r.zone.plan || 'unknown'} · read ${r.startedAt.slice(0, 16).replace('T', ' ')} UTC by ${brand} · ${s.coverage.passed + s.coverage.finding} of ${s.rules} checks read.`, '');
  L.push('Read-only: the audit read the zone\'s configuration and traffic analytics and changed nothing. Each rule is a fixed condition; `Confirmed` means the configuration or the numbers prove the outcome, `Needs validation` means the outcome depends on something they cannot show — the finding says what to check.', '');
  L.push('## Summary', '');
  L.push('| Severity | Findings |', '| --- | --- |', ...SEVERITIES.map((v) => `| ${SEVERITY_LABEL[v]} | ${s.bySeverity[v]} |`), '');
  L.push(`${s.byVerdict.confirmed} confirmed, ${s.byVerdict.needs_validation} need validation. Coverage: ${compactNum(s.rules)} rules — ${s.coverage.passed} passed, ${s.coverage.finding} with findings, ${s.coverage.not_applicable} not applicable, ${s.coverage.not_read} not read.`, '');
  if (s.coverage.not_read) L.push(`**${s.coverage.not_read} rules could not be checked** (see the coverage ledger): a clean result does not cover them.`, '');

  const p = postureOf(r);
  const share = (x: number | null) => (x === null ? 'not measured' : `${Math.round(x * 100)}%`);
  L.push('## Posture', '', `**Grade: ${p.grade ?? '—'} (${p.label}${p.score === null ? '' : `, ${p.score}/100`})**`, '', p.verdict, '');
  if (p.gradeProof.rows.length) {
    const sw = p.gradeProof.rows.reduce((a, x) => a + x.score * x.weight, 0), w = p.gradeProof.rows.reduce((a, x) => a + x.weight, 0);
    L.push('**How the grade was worked out:** weighted mean of the graded areas = Σ (score × weight) ÷ Σ weight = '
      + `${p.gradeProof.rows.map((x) => `${x.score}×${x.weight}`).join(' + ')} = ${sw} ÷ ${w} = ${p.gradeProof.mean}${p.gradeProof.cap ? `; ${p.gradeProof.cap}` : ''}. Grade floors: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 55, else F.`, '');
  }
  L.push('### Scorecard', '', '| Area | Rating | Score | Checks read | Worst finding |', '| --- | --- | --- | --- | --- |',
    ...p.areas.filter((a) => a.rating !== 'not_applicable').map((a) => `| ${a.label} | ${RATING_LABEL[a.rating]} | ${a.score ?? '—'} | ${a.read} of ${a.applicable} | ${a.top ? md(`${SEVERITY_LABEL[a.top.severity]}: ${a.top.title}`) : '—'} |`), '');
  L.push(`**How each area score was worked out:** 100 minus each finding's points (critical ${PENALTY.critical}, high ${PENALTY.high}, medium ${PENALTY.medium}, low ${PENALTY.low}; half when it needs validation), never below 0.`, '');
  for (const a of p.areas.filter((x) => x.score !== null && x.penalties.length)) L.push(`- ${a.label}: 100 − (${a.penalties.map((x) => x.points).join(' + ')}) = ${a.score} — ${a.penalties.map((x) => md(`${x.title} (${x.severity}${x.verdict === 'needs_validation' ? ', needs validation' : ''}: −${x.points})`)).join('; ')}`);
  L.push('');
  const en = p.enforcement;
  L.push('### Enforcement in the traffic', '', `- Security events: ${en.events === null ? 'not read' : compactNum(en.events)}`, `- Blocked or challenged (of decided events): ${share(en.enforcedShare)}`,
    `- Managed and custom rule matches only logged: ${share(en.logOnlyShare)}${en.logOnlyShare === 0 ? ' (no log-only evidence — not proof that every rule enforces)' : ''}`,
    `- Challenge solve rate: ${share(en.solveRate)}`, `- Bot or malicious requests let through: ${en.badLetThrough === null ? 'not measured' : compactNum(en.badLetThrough)}`,
    `- Enabled rules with no match in the window: ${en.silent === null ? 'not read' : `${en.silent} of ${en.configured}`}`, '');
  if (en.proof) {
    const c = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${compactNum(v)}`).join(' + ') || 'none';
    L.push('**How these were worked out** (from the security events, GraphQL firewallEventsAdaptiveGroups; queries in the appendix):', '',
      `- Blocked or challenged = (${c(en.proof.enforcedByAction)}) ÷ ((${c(en.proof.enforcedByAction)}) + (${c(en.proof.passiveByAction)})) = ${share(en.enforcedShare)}`,
      `- Only logged = ${compactNum(en.proof.wafLogged)} Log ÷ ${compactNum(en.proof.wafDecided)} decided managed and custom matches = ${share(en.logOnlyShare)}`,
      `- Solve rate = ${compactNum(en.proof.solved)} solved ÷ ${compactNum(en.proof.challenged)} challenges${en.proof.challenged < 10 ? ' (fewer than 10: not measured)' : ` = ${share(en.solveRate)}`}`,
      `- Let through: ${en.proof.badByRule.length ? en.proof.badByRule.map((x) => md(`${x.rule}: ${compactNum(x.bots)} bots + ${compactNum(x.malicious)} malicious`)).join('; ') : 'none'}`,
      `- Rules with no match: ${en.proof.silentRules.length ? md(en.proof.silentRules.join(', ')) : 'none'}`, '');
  }
  L.push('### Threat coverage', '', '| Threat | Status | In place | Gaps |', '| --- | --- | --- | --- |',
    ...p.threats.filter((t) => t.status !== 'not_applicable').map((t) => `| ${t.label} | ${THREAT_LABEL[t.status]} | ${md(t.controls.join('; ') || '—')} | ${md(t.gaps.map((x) => x.title).join('; ') || '—')} |`), '');
  for (const t of p.threats.filter((t) => t.playbook.length)) L.push(`- **${t.label}:** ${t.playbook.join(' ')}`);
  if (p.threats.some((t) => t.playbook.length)) L.push('');
  const steps = (title: string, list: typeof p.steps.immediate) => { if (list.length) L.push(`### ${title}`, '', ...list.map((x, i) => `${i + 1}. **${x.title}**${x.severity ? ` (${x.severity})` : ''}${md(appliesTo(x.fingerprint ? byFp.get(x.fingerprint) : undefined))}${x.detail ? ` — ${x.detail}` : ''}`), ''); };
  steps('Immediate', p.steps.immediate);
  steps('Short term', p.steps.shortTerm);
  steps('Hardening', p.steps.hardening);
  if (p.steps.more) L.push(`${p.steps.more} more in the findings below.`, '');
  if (p.noCost.length) L.push('### No-cost fixes (any plan)', '', ...p.noCost.map((x) => `- ${x.title}`), '');
  if (p.upgrades.length) L.push('### Plan upgrades that would close a gap', '', ...p.upgrades.map((u) => `- **${u.feature}** (${u.plan}): ${u.why}`), '');
  L.push('### What to monitor', '', ...p.monitor.map((x) => `- ${x}`), '', '### Assumptions and limits', '', ...p.limits.map((x) => `- ${x}`), '');

  L.push('## Findings', '');
  if (!r.findings.length) L.push('No findings in the rules that were read.', '');
  r.findings.forEach((f, i) => {
    L.push(`### ${i + 1}. ${f.title}`, '');
    L.push(`**${SEVERITY_LABEL[f.severity]} · ${VERDICT_LABEL[f.verdict]}** · ${GROUP_LABEL[f.group]} · rule \`${f.ruleId}\` · attack class: ${f.attackClass} (${f.skillRef})`, '');
    const refs = findingRules(f, r, idx);
    if (refs.length) L.push(`**Applies to:** ${refs.map(refText).join(', ')}`, '');
    L.push(f.description, '', `*Root cause:* ${f.rootCause}`, '', `*Intended behaviour:* ${f.intendedBehavior}`, '');
    L.push('**Proof:**', '');
    for (const e of f.evidence) {
      L.push(`- \`${e.source}\` — ${e.field}: ${tick(e.value)} — ${e.check ? CHECK_LABEL[e.check] : 'not checked (older audit)'}`);
      const cmd = reproduce(e, r);
      if (cmd) L.push(`  - Re-check: \`${cmd.replace(/`/g, "'")}\``);
      if (e.raw) L.push(`  - ${e.check === 'matches' ? 'The record in Cloudflare\'s answer' : 'Cloudflare\'s answer the rule read'}:`, '', '    ```json', ...e.raw.split('\n').map((l) => `    ${l}`), '    ```');
    }
    L.push('');
    const x = explain(f, r);
    L.push(`**Priority:** ${x.priority}`, '');
    L.push('**What to do** (not applied — make the change in the dashboard):', '', ...x.what.map((t, n) => `${n + 1}. ${t}`), '');
    L.push('**Why:**', '', ...x.why.map((t) => `- ${t}`), '');
    L.push('**How it will help:**', '', ...x.helps.map((t) => `- ${t}`), '');
    if (x.risks.length) L.push('**Risks and how to roll it out:**', '', ...x.risks.map((t) => `- ${t}`), '');
    L.push('**How to confirm it worked:**', '', ...x.confirm.map((t) => `- ${t}`), '');
    L.push(`Fingerprint: \`${f.fingerprint}\``, '');
  });

  const items = actionItems(r);
  L.push('## Recommended actions', '', 'Traffic recommendations for rules that let requests through, and the fix of every confirmed high or critical finding, most important first. Not applied.', '');
  if (!items.length) L.push('Nothing to change in what was read.', '');
  items.forEach((x, i) => {
    L.push(`${i + 1}. **${x.title}** (${x.source === 'traffic' ? 'from traffic' : 'from configuration'}: ${x.rules?.length ? x.rules.map(refText).join(', ') : x.ruleName}${x.severity ? `; ${SEVERITY_LABEL[x.severity]}` : ''}${x.impact ? `; ${x.impact} requests` : ''}${x.fingerprint ? `; finding \`${x.fingerprint}\`` : ''})`);
    for (const st of x.steps) L.push(`   - ${st}`);
    if (x.expression) L.push(`   - Expression: ${tick(x.expression)}`);
  });
  L.push('');

  const e = r.effectiveness;
  L.push('## Effectiveness', '');
  if (!e) L.push(`Not read: ${r.reads.find((x) => x.key === 'events')?.reason ?? 'security events were not read'}.`, '');
  else {
    L.push(`Window: ${windowLabel(e.hours)} (${e.since.slice(0, 16).replace('T', ' ')} – ${e.until.slice(0, 16).replace('T', ' ')} UTC)${e.hours < e.askedHours ? `, shortened from ${windowLabel(e.askedHours)}` : ''}. ${e.totalEvents} security events (sampled by Cloudflare).`, '');
    for (const n of e.notes) L.push(`> ${n}`, '');
    L.push('| Kind | Rule | Events | By action | Solve rate | Trend | Let through | Recommendation |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const x of e.rules) {
      const p = x.passthrough;
      L.push(`| ${REF_LABEL[effectRef(x).kind]} | ${md(x.name)} | ${compactNum(x.events)} | ${md(Object.entries(x.byAction).map(([a, n]) => `${a} ${compactNum(n)}`).join(', '))} | ${x.solveRate === null ? '' : `${Math.round(x.solveRate * 100)}%`} | ${x.trend === null ? '' : `${x.trend >= 0 ? '+' : ''}${Math.round(x.trend * 100)}%`} | ${p ? `${compactNum(p.passed)}: ${compactNum(p.bots)} automated, ${compactNum(p.malicious)} malicious` : ''} | ${p ? md(p.recommendation.title) : ''} |`);
    }
    if (e.notAnalysed.length) L.push('', `Not analysed: ${e.notAnalysed.map((x) => `${x.ruleName} (${compactNum(x.passed)})`).join(', ')} — ${e.notAnalysed[0].reason}.`);
    L.push('');
  }

  L.push('## Managed ruleset', '');
  const m = r.managed;
  if (!m) L.push('Not in this report (made before the managed ruleset overview existed).', '');
  else {
    L.push(`Leaked credentials detection: ${m.leakedCredentials}.`, '', '| Ruleset | State | Scope | Overrides | OWASP tuning | Events |', '| --- | --- | --- | --- | --- | --- |');
    for (const x of m.rulesets) L.push(`| ${x.name} | ${x.state}${x.reason ? ` (${md(x.reason)})` : ''} | ${md(x.scope ?? '')} | ${md([x.action ? `ruleset action ${x.action}` : '', ...x.overrides.map((o) => `${o.kind} ${o.id}: ${o.change}`)].filter(Boolean).join('; '))} | ${x.threshold !== undefined ? `PL${x.paranoia ?? '1 (default)'}, threshold ${x.threshold}` : ''} | ${x.events ? `${compactNum(x.events.total)}${x.events.total ? ` (${md(Object.entries(x.events.byAction).map(([a, n]) => `${a} ${compactNum(n)}`).join(', '))})` : ''}` : 'not read'} |`);
    L.push('', 'Exceptions (skip rules), in order:', '');
    if (!m.exceptions.length) L.push('- None.');
    for (const x of m.exceptions) L.push(`- **${x.name}**${x.enabled ? '' : ' (disabled)'} — skips ${x.skips}; ${x.position === 'after' ? 'placed after the deploy rules (no effect); ' : ''}expression ${tick(x.expression || '(none)')}; ${x.skipped === null ? 'traffic not read' : `${compactNum(x.skipped)} requests skipped${x.verdict ? ` (${x.verdict})` : ''}`}.`);
    L.push('');
  }

  L.push('## Coverage ledger', '', '| Rule | Group | State | Findings | Note |', '| --- | --- | --- | --- | --- |');
  for (const c of r.coverage) L.push(`| \`${c.ruleId}\` ${md(c.title)} | ${GROUP_LABEL[c.group]} | ${COVERAGE_LABEL[c.state]} | ${c.findings} | ${md([c.reason ?? '', c.permission ? `needs permission: ${c.permission}` : ''].filter(Boolean).join(' — '))} |`);
  L.push('', '## Method', '', `${s.calls} Cloudflare API calls (GET, plus GraphQL analytics queries) and ${s.lookups} public DNS lookups.`, '');
  L.push('| Source | Read |', '| --- | --- |', ...r.reads.map((x) => `| ${md(x.label)} | ${x.state === 'ok' ? 'yes' : `${x.state === 'absent' ? 'not on this zone' : 'no'}${x.reason ? ` — ${md(x.reason)}` : ''}`} |`), '');
  const checks = r.verification ?? verifyReport(r);
  L.push('## Verification', '', `Every count recomputed a second way${r.verification ? ' (traffic totals from the raw analytics rows) when the report was built' : ''}: ${checks.filter((c) => c.ok).length} of ${checks.length} hold.`, '',
    '| Check | Result | Detail |', '| --- | --- | --- |', ...checks.map((c) => `| ${md(c.label)} | ${c.ok ? 'Holds' : '**Failed**'} | ${md(c.detail)} |`), '');
  if (r.queries?.length) {
    L.push('## Appendix: analytics queries', '', `${r.queries.length} GraphQL queries as sent to https://api.cloudflare.com/client/v4/graphql. Every traffic number above is a sum of their rows.`, '');
    r.queries.forEach((q, n) => L.push(`${n + 1}. ${q.dataset}, ${q.since} → ${q.until}`, '', '   ```graphql', `   ${q.text}`, '   ```', ''));
  }
  return L.join('\n');
}
