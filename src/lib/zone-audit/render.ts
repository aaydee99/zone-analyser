// The audit report as files: findings.json (the finding records), REPORT.md, and CSV (findings,
// coverage or rule effectiveness). Pure — shared by the download route and the tests. Wording is
// target-neutral and every number comes from the report.

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

export type CsvPart = 'findings' | 'coverage' | 'effectiveness';
export const isCsvPart = (v: string): v is CsvPart => v === 'findings' || v === 'coverage' || v === 'effectiveness';

export function auditCsv(r: AuditReport, part: CsvPart): string {
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

/** REPORT.md: summary, findings worst first (evidence, fix, validation), rule effectiveness, coverage ledger and method. */
export function auditMarkdown(r: AuditReport, brand: string): string {
  const s = r.summary;
  const L: string[] = [];
  L.push(`# Security audit — ${r.zone.name}`, '');
  L.push(`Zone ID \`${r.zone.id}\` · account ${r.zone.accountName || r.zone.accountId} · plan ${r.zone.plan || 'unknown'} · read ${r.startedAt.slice(0, 16).replace('T', ' ')} UTC by ${brand}.`, '');
  L.push('Read-only: the audit read the zone\'s configuration and traffic analytics and changed nothing. Each rule is a fixed condition; `Confirmed` means the configuration or the numbers prove the outcome, `Needs validation` means the outcome depends on something they cannot show — the finding says what to check.', '');
  L.push('## Summary', '');
  L.push('| Severity | Findings |', '| --- | --- |', ...SEVERITIES.map((v) => `| ${SEVERITY_LABEL[v]} | ${s.bySeverity[v]} |`), '');
  L.push(`${s.byVerdict.confirmed} confirmed, ${s.byVerdict.needs_validation} need validation. Coverage: ${s.rules} rules — ${s.coverage.passed} passed, ${s.coverage.finding} with findings, ${s.coverage.not_applicable} not applicable, ${s.coverage.not_read} not read.`, '');
  if (s.coverage.not_read) L.push(`**${s.coverage.not_read} rules could not be checked** (see the coverage ledger): a clean result does not cover them.`, '');
  const recs = r.effectiveness?.recommendations ?? [];
  if (recs.length) {
    L.push('## Recommended actions', '', 'For every rule that lets traffic through (log, skip, allow, solved challenges), most impact first. Not applied.', '');
    recs.forEach((x, i) => {
      L.push(`${i + 1}. **${x.title}** (${KIND_LABEL[x.kind]}: ${x.ruleName}${x.impact ? `; ${x.impact} requests` : ''}${x.fingerprint ? `; evidence \`${x.fingerprint}\`` : ''})`);
      for (const st of x.steps) L.push(`   - ${st}`);
      if (x.expression) L.push(`   - Expression: \`${x.expression.replace(/`/g, "'")}\``);
    });
    L.push('');
  }
  L.push('## Findings', '');
  if (!r.findings.length) L.push('No findings in the rules that were read.', '');
  r.findings.forEach((f, i) => {
    L.push(`### ${i + 1}. ${f.title}`, '');
    L.push(`**${SEVERITY_LABEL[f.severity]} · ${VERDICT_LABEL[f.verdict]}** · ${GROUP_LABEL[f.group]} · rule \`${f.ruleId}\` · attack class: ${f.attackClass} (${f.skillRef})`, '');
    L.push(f.description, '', `*Root cause:* ${f.rootCause}`, '', `*Intended behaviour:* ${f.intendedBehavior}`, '');
    L.push('Evidence:', '', ...f.evidence.map((e) => `- \`${e.source}\` — ${e.field}: \`${e.value.replace(/`/g, "'")}\``), '');
    L.push('Fix (not applied):', '', ...f.fix.map((x, n) => `${n + 1}. ${x}`), '');
    if (f.validation) L.push(`How to validate: ${f.validation}`, '');
    L.push(`Fingerprint: \`${f.fingerprint}\``, '');
  });
  const e = r.effectiveness;
  L.push('## Rule effectiveness', '');
  if (!e) L.push(`Not read: ${r.reads.find((x) => x.key === 'events')?.reason ?? 'security events were not read'}.`, '');
  else {
    L.push(`Window: ${windowLabel(e.hours)} (${e.since.slice(0, 16).replace('T', ' ')} – ${e.until.slice(0, 16).replace('T', ' ')} UTC)${e.hours < e.askedHours ? `, shortened from ${windowLabel(e.askedHours)}` : ''}. ${e.totalEvents} security events (sampled by Cloudflare).`, '');
    for (const n of e.notes) L.push(`> ${n}`, '');
    L.push('| Kind | Rule | Events | By action | Solve rate | Trend | Top paths |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const x of e.rules) L.push(`| ${KIND_LABEL[x.kind]} | ${md(x.name)} | ${x.events} | ${md(Object.entries(x.byAction).map(([a, n]) => `${a} ${n}`).join(', '))} | ${x.solveRate === null ? '' : `${Math.round(x.solveRate * 100)}%`} | ${x.trend === null ? '' : `${x.trend >= 0 ? '+' : ''}${Math.round(x.trend * 100)}%`} | ${md(x.topPaths.slice(0, 3).map((p) => `${p.path} (${p.count})`).join(', '))} |`);
    L.push('', 'Recommendations from these numbers are listed with the findings (group "Rule effectiveness (traffic)").', '');
  }
  L.push('## Coverage ledger', '', '| Rule | Group | State | Findings | Note |', '| --- | --- | --- | --- | --- |');
  for (const c of r.coverage) L.push(`| \`${c.ruleId}\` ${md(c.title)} | ${GROUP_LABEL[c.group]} | ${COVERAGE_LABEL[c.state]} | ${c.findings} | ${md([c.reason ?? '', c.permission ? `needs permission: ${c.permission}` : ''].filter(Boolean).join(' — '))} |`);
  L.push('', '## Method', '', `${s.calls} Cloudflare API calls (GET, plus GraphQL analytics queries) and ${s.lookups} public DNS lookups.`, '');
  L.push('| Source | Read |', '| --- | --- |', ...r.reads.map((x) => `| ${md(x.label)} | ${x.state === 'ok' ? 'yes' : `${x.state === 'absent' ? 'not on this zone' : 'no'}${x.reason ? ` — ${md(x.reason)}` : ''}`} |`), '');
  return L.join('\n');
}
