// The Recommended Actions list of a report. Pure, shared by the page and REPORT.md.

import type { ActionItem, AuditReport } from './types';

/**
 * The Recommended Actions list: every traffic recommendation that changes something, then the fix of
 * each confirmed critical or high finding (not already covered by a traffic recommendation), most
 * impact first. Keep / no-conclusion recommendations stay in Effectiveness.
 */
export function actionItems(r: AuditReport): ActionItem[] {
  const recs = (r.effectiveness?.recommendations ?? []).filter((x) => x.action !== 'keep' && x.action !== 'no_conclusion');
  const linked = new Set(recs.map((x) => x.fingerprint).filter(Boolean));
  const sev = new Map(r.findings.map((f) => [f.fingerprint, f.severity]));
  const traffic: ActionItem[] = recs.map((x) => ({ source: 'traffic', title: x.title, steps: x.steps, expression: x.expression, severity: x.fingerprint ? sev.get(x.fingerprint) ?? null : null, impact: x.impact, action: x.action, fingerprint: x.fingerprint, ruleName: x.ruleName, ruleKey: x.ruleKey }));
  const fixes: ActionItem[] = r.findings.filter((f) => f.verdict === 'confirmed' && (f.severity === 'critical' || f.severity === 'high') && !linked.has(f.fingerprint))
    .map((f) => ({ source: 'finding', title: f.title, steps: f.fix, severity: f.severity, impact: 0, action: 'fix', fingerprint: f.fingerprint, ruleName: f.ruleId }));
  const rank = (x: ActionItem) => (x.severity === 'critical' ? 0 : x.severity === 'high' ? 1 : 2);
  return [...traffic, ...fixes].sort((a, b) => rank(a) - rank(b) || b.impact - a.impact || a.title.localeCompare(b.title));
}
