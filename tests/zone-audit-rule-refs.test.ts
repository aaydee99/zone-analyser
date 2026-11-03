import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReport } from '@/lib/zone-audit/report';
import { actionItems, findingRules } from '@/lib/zone-audit/actions';
import { CF_MANAGED } from '@/lib/zone-audit/rules';
import { auditCsv, auditMarkdown } from '@/lib/zone-audit/render';
import { effectRef, refText } from '@/lib/zone-audit/rule-refs';
import { clientReport } from '@/lib/zone-audit/client-report';
import { postureOf } from '@/lib/zone-audit/posture';
import { EVIDENCE_MAX, redact, type Snapshot, type SourceKey } from '@/lib/zone-audit/types';
import { messyZone } from './client-report.test';

// Each finding names the zone's rules it is about, with their type: custom, rate limiting, managed,
// OWASP, managed-rule exception, a managed ruleset. Test data only (example.test).

const OWASP = '4814384a9e5d4991b9815dcfc25d2f1f';
const NOW = '2026-11-01T00:00:00.000Z';
const report = (s: Snapshot) => buildReport(s, { accountId: 'a1', accountName: 'Example Retail', startedAt: NOW, finishedAt: NOW, calls: 0, lookups: 0 });
const withReads = (o: Record<string, unknown>) => { const s = messyZone(); for (const [k, v] of Object.entries(o)) s.reads[k as SourceKey] = { state: 'ok', value: v }; return s; };
const refsFor = (r: ReturnType<typeof report>, ruleId: string) => r.findings.filter((f) => f.ruleId === ruleId).flatMap((f) => (f.rules ?? []).map(refText));

test('traffic findings name their rule; a check about several rules names each; a missing feature names none', () => {
  const r = report(messyZone());
  assert.deepEqual(refsFor(r, 'traffic.passthrough').sort(), ['Custom rule “Watch API”', 'Custom rule “Watch shop”']);
  assert.deepEqual(refsFor(r, 'waf.custom_log_only'), ['Custom rule “Watch API”', 'Custom rule “Watch shop”']);
  assert.deepEqual(refsFor(r, 'waf.owasp'), ['OWASP Core Ruleset']);
  assert.deepEqual(refsFor(r, 'avail.rate_limits'), []);
  assert.deepEqual(refsFor(r, 'tls.ssl_mode'), []);
});

test('custom, rate limiting, managed exception and managed ruleset findings name their rule', () => {
  const r = report(withReads({
    'phase:http_request_firewall_custom': [{ id: 's1', description: 'Skip all', action: 'skip', expression: 'true', action_parameters: { ruleset: 'current' } }],
    'phase:http_ratelimit': [{ id: 'rl1', description: 'Login', action: 'log', expression: '(http.request.uri.path eq "/login")', ratelimit: { characteristics: ['cf.colo.id', 'ip.src'], period: 60, requests_per_period: 5, mitigation_timeout: 600 } }],
    'phase:http_request_firewall_managed': [
      { id: 'ex1', description: 'Partner skip', action: 'skip', expression: 'true', action_parameters: { ruleset: 'current' } },
      { id: 'm-dep', action: 'execute', expression: 'true', action_parameters: { id: CF_MANAGED, overrides: { action: 'log' } } },
      { id: 'o-dep', action: 'execute', expression: 'true', action_parameters: { id: OWASP } },
    ],
  }));
  assert.ok(refsFor(r, 'waf.broad_skip').includes('Custom rule “Skip all”'), JSON.stringify(refsFor(r, 'waf.broad_skip')));
  assert.ok(refsFor(r, 'avail.ratelimit_depth').includes('Rate limiting rule “Login”'), JSON.stringify(refsFor(r, 'avail.ratelimit_depth')));
  assert.ok(refsFor(r, 'managed.exceptions').includes('Managed rule exception “Partner skip”'), JSON.stringify(refsFor(r, 'managed.exceptions')));
  assert.ok(refsFor(r, 'managed.cf_overrides').includes('Cloudflare Managed Ruleset'), JSON.stringify(refsFor(r, 'managed.cf_overrides')));
});

test('a traffic row is a managed rule, an OWASP rule or an exception', () => {
  const base = { kind: 'managed' as const, name: 'SQLi', ruleId: 'm1', rulesetId: CF_MANAGED, exception: false };
  assert.equal(refText(effectRef(base)), 'Managed rule “SQLi”');
  assert.equal(refText(effectRef({ ...base, rulesetId: OWASP, name: '949110: Inbound Anomaly Score Exceeded' })), 'OWASP rule “949110: Inbound Anomaly Score Exceeded”');
  assert.equal(refText(effectRef({ ...base, exception: true, name: 'Partner skip' })), 'Managed rule exception “Partner skip”');
  assert.equal(refText(effectRef({ ...base, kind: 'ratelimit', name: 'Login' })), 'Rate limiting rule “Login”');
});

test('older audits (no stored rules) still name traffic rules; actions, REPORT.md, CSV and the Word report show them', () => {
  const r = report(messyZone());
  const old = { ...r, findings: r.findings.map(({ rules: _drop, ...f }) => f) };
  const tf = old.findings.find((f) => f.ruleId === 'traffic.passthrough')!;
  assert.match(findingRules(tf, old).map(refText).join(), /Custom rule “Watch (API|shop)”/);
  const act = actionItems(r).find((x) => x.source === 'traffic')!;
  assert.match((act.rules ?? []).map(refText).join(), /Custom rule “Watch/);
  const md = auditMarkdown(r, 'Test');
  assert.match(md, /\*\*Applies to:\*\* Custom rule “Watch API”/);
  assert.match(md, /from traffic: Custom rule “Watch/);
  const csv = auditCsv(r, 'findings');
  assert.match(csv.split('\r\n')[0], /title,applies_to,/);
  assert.match(csv, /Custom rule “Watch API”/);
  const c = clientReport(r, { client: 'Example Retail' });
  assert.ok(c.gaps.some((g) => g.rows[0].lines.some((l) => /^Rules involved: .*Custom rule “Watch API”/.test(l))));
  assert.ok(c.gaps.some((g) => g.rows[0].lines.some((l) => /OWASP Core Ruleset/.test(l))));
});

test('an IP Access rule names its action and the address it matches, in the page, REPORT.md and the Word report', () => {
  const r = report(withReads({ access_rules: [{ id: 'ar1', mode: 'whitelist', notes: 'Partner office', configuration: { target: 'ip_range', value: '198.51.0.0/16' } }] }));
  const refs = r.findings.filter((f) => f.ruleId === 'bypass.ip_access_allow').flatMap((f) => f.rules ?? []);
  assert.deepEqual(refs.map((x) => [x.kind, x.name, x.detail]), [['access', 'Partner office', 'Allow · IP range 198.51.0.0/16']]);
  assert.equal(refText(refs[0]), 'IP Access rule “Partner office” (Allow · IP range 198.51.0.0/16)');
  assert.match(auditMarkdown(r, 'Test'), /Applies to:\*\* IP Access rule “Partner office” \(Allow · IP range 198\.51\.0\.0\/16\)/);
  // The client keeps its own allow entry (only origin addresses are withheld).
  const c = clientReport(r, { client: 'Example Retail' });
  assert.ok(c.gaps.some((g) => g.rows[0].lines.some((l) => l.includes('IP range 198.51.0.0/16'))), 'the Word report names the range');
});

test('nothing is cut short: long evidence values, every posture step', () => {
  const long = `(http.request.uri.path in {${Array.from({ length: 80 }, (_, i) => `"/very/long/path/number/${i}"`).join(' ')}})`;
  assert.ok(long.length > 2000);
  // A rule expression is kept whole (it used to stop at 400 characters with an ellipsis).
  assert.equal(redact('expression', long), long);
  assert.match(redact('expression', 'x'.repeat(EVIDENCE_MAX + 5)), /\[first 20,000 of 20,005 characters\]$/);
  const r = report(messyZone());
  assert.ok(!r.findings.flatMap((f) => f.evidence.map((e) => `${e.value} ${e.raw ?? ''}`)).some((v) => /…/.test(v)), 'no evidence cut with an ellipsis');
  const p = postureOf(r);
  assert.equal(p.steps.more, 0);
  const listed = p.steps.immediate.length + p.steps.shortTerm.length + p.steps.hardening.length;
  assert.ok(listed > 8, `${listed} steps listed (no cap of 8)`);
});
