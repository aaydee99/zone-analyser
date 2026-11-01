// The audit report as files: findings.json (the finding records), REPORT.md, and CSV (findings,
// coverage or rule effectiveness). Pure — shared by the download route and the tests. Wording is
// target-neutral and every number comes from the report.

import { actionItems } from './actions';
import { GROUP_LABEL, COVERAGE_LABEL, KIND_LABEL, SEVERITIES, SEVERITY_LABEL, VERDICT_LABEL, windowLabel, type AuditReport } from './types';

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
      x.events?.total ?? '', x.events?.byAction ?? '', (x.events?.topRules ?? []).map((t) => `${t.ruleId} ${t.total}${t.logOnly ? ' (log only)' : ''}`).join('; ')]));
  if (part === 'coverage') return csv(['rule', 'title', 'group', 'state', 'findings', 'reason', 'permission', 'attack_class', 'skill_ref'],
    r.coverage.map((c) => [c.ruleId, c.title, GROUP_LABEL[c.group], c.state, c.findings, c.reason ?? '', c.permission ?? '', c.attackClass, c.skillRef]));
  if (part === 'effectiveness') return csv(['kind', 'rule', 'ruleset', 'source', 'name', 'configured', 'config_action', 'events', 'by_action', 'challenged', 'solved', 'solve_rate', 'previous', 'trend', 'top_paths', 'top_countries', 'top_networks', 'passed', 'passed_bots', 'bot_basis', 'passed_malicious', 'malicious_basis', 'verdict', 'recommendation'],
    (r.effectiveness?.rules ?? []).map((x) => [KIND_LABEL[x.kind], x.ruleId, x.rulesetId, x.source, x.name, x.configured, x.configAction ?? '', x.events, x.byAction, x.challenged, x.solved,
      x.solveRate === null ? '' : x.solveRate.toFixed(3), x.previous ?? '', x.trend === null ? '' : x.trend.toFixed(3),
      x.topPaths.map((p) => `${p.path} (${p.count})`).join('; '), x.topCountries.map((p) => `${p.country} (${p.count})`).join('; '), x.topAsns.map((p) => `AS${p.asn} ${p.name} (${p.count})`).join('; '),
      x.passthrough?.passed ?? '', x.passthrough?.bots ?? '', x.passthrough?.botBasis ?? '', x.passthrough?.malicious ?? '', x.passthrough?.maliciousBasis ?? '', x.passthrough?.verdict ?? '', x.passthrough?.recommendation.title ?? '']));
  return csv(['severity', 'verdict', 'rule', 'group', 'title', 'attack_class', 'skill_ref', 'description', 'root_cause', 'evidence', 'fix', 'validation', 'fingerprint'],
    r.findings.map((f) => [f.severity, f.verdict, f.ruleId, GROUP_LABEL[f.group], f.title, f.attackClass, f.skillRef, f.description, f.rootCause,
      f.evidence.map((e) => `${e.source} ${e.field} = ${e.value}`).join(' | '), f.fix.join(' | '), f.validation ?? '', f.fingerprint]));
}

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** REPORT.md, in the page's order: summary, findings, recommended actions, effectiveness, managed ruleset, coverage ledger, method. */
export function auditMarkdown(r: AuditReport, brand: string): string {
  const s = r.summary;
  const L: string[] = [];
  const tick = (v: string) => `\`${v.replace(/`/g, "'")}\``;
  L.push(`# Security audit — ${r.zone.name}`, '');
  L.push(`Zone ID \`${r.zone.id}\` · account ${r.zone.accountName || r.zone.accountId} · plan ${r.zone.plan || 'unknown'} · read ${r.startedAt.slice(0, 16).replace('T', ' ')} UTC by ${brand} · ${s.coverage.passed + s.coverage.finding} of ${s.rules} checks read.`, '');
  L.push('Read-only: the audit read the zone\'s configuration and traffic analytics and changed nothing. Each rule is a fixed condition; `Confirmed` means the configuration or the numbers prove the outcome, `Needs validation` means the outcome depends on something they cannot show — the finding says what to check.', '');
  L.push('## Summary', '');
  L.push('| Severity | Findings |', '| --- | --- |', ...SEVERITIES.map((v) => `| ${SEVERITY_LABEL[v]} | ${s.bySeverity[v]} |`), '');
  L.push(`${s.byVerdict.confirmed} confirmed, ${s.byVerdict.needs_validation} need validation. Coverage: ${s.rules} rules — ${s.coverage.passed} passed, ${s.coverage.finding} with findings, ${s.coverage.not_applicable} not applicable, ${s.coverage.not_read} not read.`, '');
  if (s.coverage.not_read) L.push(`**${s.coverage.not_read} rules could not be checked** (see the coverage ledger): a clean result does not cover them.`, '');

  L.push('## Findings', '');
  if (!r.findings.length) L.push('No findings in the rules that were read.', '');
  r.findings.forEach((f, i) => {
    L.push(`### ${i + 1}. ${f.title}`, '');
    L.push(`**${SEVERITY_LABEL[f.severity]} · ${VERDICT_LABEL[f.verdict]}** · ${GROUP_LABEL[f.group]} · rule \`${f.ruleId}\` · attack class: ${f.attackClass} (${f.skillRef})`, '');
    L.push(f.description, '', `*Root cause:* ${f.rootCause}`, '', `*Intended behaviour:* ${f.intendedBehavior}`, '');
    L.push('Evidence:', '', ...f.evidence.map((e) => `- \`${e.source}\` — ${e.field}: ${tick(e.value)}`), '');
    L.push('Fix (not applied):', '', ...f.fix.map((x, n) => `${n + 1}. ${x}`), '');
    if (f.validation) L.push(`How to validate: ${f.validation}`, '');
    L.push(`Fingerprint: \`${f.fingerprint}\``, '');
  });

  const items = actionItems(r);
  L.push('## Recommended actions', '', 'Traffic recommendations for rules that let requests through, and the fix of every confirmed high or critical finding, most important first. Not applied.', '');
  if (!items.length) L.push('Nothing to change in what was read.', '');
  items.forEach((x, i) => {
    L.push(`${i + 1}. **${x.title}** (${x.source === 'traffic' ? 'from traffic' : 'from configuration'}: ${x.ruleName}${x.severity ? `; ${SEVERITY_LABEL[x.severity]}` : ''}${x.impact ? `; ${x.impact} requests` : ''}${x.fingerprint ? `; finding \`${x.fingerprint}\`` : ''})`);
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
      L.push(`| ${KIND_LABEL[x.kind]} | ${md(x.name)} | ${x.events} | ${md(Object.entries(x.byAction).map(([a, n]) => `${a} ${n}`).join(', '))} | ${x.solveRate === null ? '' : `${Math.round(x.solveRate * 100)}%`} | ${x.trend === null ? '' : `${x.trend >= 0 ? '+' : ''}${Math.round(x.trend * 100)}%`} | ${p ? `${p.passed}: ${p.bots} automated, ${p.malicious} malicious` : ''} | ${p ? md(p.recommendation.title) : ''} |`);
    }
    if (e.notAnalysed.length) L.push('', `Not analysed: ${e.notAnalysed.map((x) => `${x.ruleName} (${x.passed})`).join(', ')} — ${e.notAnalysed[0].reason}.`);
    L.push('');
  }

  L.push('## Managed ruleset', '');
  const m = r.managed;
  if (!m) L.push('Not in this report (made before the managed ruleset overview existed).', '');
  else {
    L.push(`Leaked credentials detection: ${m.leakedCredentials}.`, '', '| Ruleset | State | Scope | Overrides | OWASP tuning | Events |', '| --- | --- | --- | --- | --- | --- |');
    for (const x of m.rulesets) L.push(`| ${x.name} | ${x.state}${x.reason ? ` (${md(x.reason)})` : ''} | ${md(x.scope ?? '')} | ${md([x.action ? `ruleset action ${x.action}` : '', ...x.overrides.map((o) => `${o.kind} ${o.id}: ${o.change}`)].filter(Boolean).join('; '))} | ${x.threshold !== undefined ? `PL${x.paranoia ?? '1 (default)'}, threshold ${x.threshold}` : ''} | ${x.events ? `${x.events.total}${x.events.total ? ` (${md(Object.entries(x.events.byAction).map(([a, n]) => `${a} ${n}`).join(', '))})` : ''}` : 'not read'} |`);
    L.push('', 'Exceptions (skip rules), in order:', '');
    if (!m.exceptions.length) L.push('- None.');
    for (const x of m.exceptions) L.push(`- **${x.name}**${x.enabled ? '' : ' (disabled)'} — skips ${x.skips}; ${x.position === 'after' ? 'placed after the deploy rules (no effect); ' : ''}expression ${tick(x.expression || '(none)')}; ${x.skipped === null ? 'traffic not read' : `${x.skipped} requests skipped${x.verdict ? ` (${x.verdict})` : ''}`}.`);
    L.push('');
  }

  L.push('## Coverage ledger', '', '| Rule | Group | State | Findings | Note |', '| --- | --- | --- | --- | --- |');
  for (const c of r.coverage) L.push(`| \`${c.ruleId}\` ${md(c.title)} | ${GROUP_LABEL[c.group]} | ${COVERAGE_LABEL[c.state]} | ${c.findings} | ${md([c.reason ?? '', c.permission ? `needs permission: ${c.permission}` : ''].filter(Boolean).join(' — '))} |`);
  L.push('', '## Method', '', `${s.calls} Cloudflare API calls (GET, plus GraphQL analytics queries) and ${s.lookups} public DNS lookups.`, '');
  L.push('| Source | Read |', '| --- | --- |', ...r.reads.map((x) => `| ${md(x.label)} | ${x.state === 'ok' ? 'yes' : `${x.state === 'absent' ? 'not on this zone' : 'no'}${x.reason ? ` — ${md(x.reason)}` : ''}`} |`), '');
  return L.join('\n');
}
