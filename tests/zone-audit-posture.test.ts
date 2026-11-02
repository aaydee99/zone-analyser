import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_RULES, buildReport } from '@/lib/zone-audit/report';
import { runRules } from '@/lib/zone-audit/rules';
import { accessCovers, pathTemplate } from '@/lib/zone-audit/rules-skills';
import { AREAS, THREATS, postureOf } from '@/lib/zone-audit/posture';
import { auditMarkdown } from '@/lib/zone-audit/render';
import type { Got, RequestData, Snapshot, SourceKey } from '@/lib/zone-audit/types';

// The checks taken from the Cloudflare security skills (rules-skills.ts) and the posture summary
// (posture.ts). Test data only (example.test).

const NOW = '2026-11-01T00:00:00.000Z';
const ok = <T>(value: T): Got<T> => ({ state: 'ok', value });
const req = (paths: RequestData['paths']): RequestData => ({ since: '2026-10-25T00:00:00.000Z', until: NOW, paths, asns: [], notes: [] });

/** Only what these rules read; everything else is missing (not_read), which the posture must not count as passed. */
function snap(reads: Partial<Record<SourceKey, unknown>>, plan = 'business'): Snapshot {
  const r: Snapshot['reads'] = { zone: ok({ id: 'z1', name: 'example.test', status: 'active', type: 'full', plan }) };
  for (const [k, v] of Object.entries(reads)) r[k as SourceKey] = v && typeof v === 'object' && 'state' in v ? v as Got<unknown> : ok(v);
  return { zoneId: 'z1', zoneName: 'example.test', now: NOW, reads: r, hours: 168, askedHours: 168 };
}
const run = (s: Snapshot, id: string) => {
  const { findings, coverage } = runRules(s, ALL_RULES);
  return { cov: coverage.find((c) => c.ruleId === id)!, findings: findings.filter((f) => f.ruleId === id) };
};
const report = (s: Snapshot) => buildReport(s, { accountId: 'a1', accountName: 'Test', startedAt: NOW, finishedAt: NOW, calls: 0, lookups: 0 });
const rl = (expression: string, action = 'block') => ({ id: 'rl', description: 'RL', action, expression, ratelimit: { characteristics: ['ip.src'], period: 60, requests_per_period: 5 } });

test('access.admin_paths: an admin area answering 2xx with nothing in front', () => {
  const requests = req([{ host: 'example.test', path: '/wp-admin/index.php', status: 200, count: 60 }, { host: 'example.test', path: '/wp-admin/admin-ajax.php', status: 200, count: 9000 }]);
  const bare = run(snap({ requests, 'phase:http_request_firewall_custom': [], access_apps: [] }), 'access.admin_paths');
  assert.equal(bare.findings.length, 1);
  assert.equal(bare.findings[0].verdict, 'needs_validation');
  assert.equal(bare.findings[0].severity, 'medium');
  assert.match(bare.findings[0].title, /example\.test\/wp-admin/);
  // admin-ajax is public by design: alone it is not reported.
  assert.equal(run(snap({ requests: req([{ host: 'example.test', path: '/wp-admin/admin-ajax.php', status: 200, count: 9000 }]), 'phase:http_request_firewall_custom': [] }), 'access.admin_paths').cov.state, 'passed');
  // An Access application, or a blocking custom rule naming the path, covers it.
  assert.equal(run(snap({ requests, 'phase:http_request_firewall_custom': [], access_apps: [{ id: 'a', type: 'self_hosted', domain: 'example.test/wp-admin*' }] }), 'access.admin_paths').cov.state, 'passed');
  assert.equal(run(snap({ requests, 'phase:http_request_firewall_custom': [{ id: 'c', action: 'block', expression: '(starts_with(http.request.uri.path, "/wp-admin") and not ip.src in $office)' }] }), 'access.admin_paths').cov.state, 'passed');
  // A log-only rule does not.
  assert.equal(run(snap({ requests, 'phase:http_request_firewall_custom': [{ id: 'c', action: 'log', expression: '(starts_with(http.request.uri.path, "/wp-admin"))' }] }), 'access.admin_paths').cov.state, 'finding');
  // Access applications unread: still checked, and the finding says so.
  assert.match(run(snap({ requests, 'phase:http_request_firewall_custom': [] }), 'access.admin_paths').findings[0].description, /could not be read/);
});

test('accessCovers and pathTemplate', () => {
  assert.ok(accessCovers([{ id: '1', self_hosted_domains: ['*.example.test'] }], 'admin.example.test', '/x'));
  assert.ok(!accessCovers([{ id: '1', domain: 'example.test/app' }], 'example.test', '/admin'));
  assert.ok(!accessCovers([{ id: '1', type: 'saas', domain: 'example.test' }], 'example.test', '/admin'));
  assert.equal(pathTemplate('/api/users/123/orders/8f14e45fceea167a5a36dedd4bea2543'), '/api/users/{id}/orders/{id}');
});

test('avail.login_rate_limit', () => {
  const requests = req([{ host: 'example.test', path: '/account/login', status: 200, count: 500 }]);
  const r = run(snap({ requests, 'phase:http_ratelimit': [rl('(http.request.uri.path eq "/search")')] }), 'avail.login_rate_limit');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'medium');
  assert.equal(run(snap({ requests, 'phase:http_ratelimit': [rl('(http.request.uri.path eq "/account/login")')] }), 'avail.login_rate_limit').cov.state, 'passed');
  // A log-only limit does not count; none at all is avail.rate_limits' finding.
  assert.equal(run(snap({ requests, 'phase:http_ratelimit': [rl('(http.request.uri.path eq "/account/login")', 'log')] }), 'avail.login_rate_limit').cov.state, 'not_applicable');
});

test('bots.login_turnstile', () => {
  const requests = req([{ host: 'shop.example.test', path: '/login', status: 200, count: 300 }]);
  assert.equal(run(snap({ requests, turnstile_widgets: [] }), 'bots.login_turnstile').findings[0].severity, 'low');
  assert.equal(run(snap({ requests, turnstile_widgets: [{ sitekey: 'k', domains: ['example.test'] }] }), 'bots.login_turnstile').cov.state, 'passed');
  assert.equal(run(snap({ requests }), 'bots.login_turnstile').cov.state, 'not_read');
});

test('traffic.credential_stuffing', () => {
  const stuffing = req([{ host: 'example.test', path: '/login', status: 401, count: 6000 }, { host: 'example.test', path: '/login', status: 200, count: 1000 }, { host: 'example.test', path: '/login', status: 429, count: 200 }]);
  const r = run(snap({ requests: stuffing }), 'traffic.credential_stuffing');
  assert.equal(r.findings[0].severity, 'high');
  assert.match(r.findings[0].description, /No rate limiting rule covers/);
  assert.equal(run(snap({ requests: stuffing, 'phase:http_ratelimit': [rl('(http.request.uri.path eq "/login")')] }), 'traffic.credential_stuffing').findings[0].severity, 'medium');
  assert.equal(run(snap({ requests: req([{ host: 'example.test', path: '/login', status: 200, count: 6000 }, { host: 'example.test', path: '/login', status: 401, count: 300 }]) }), 'traffic.credential_stuffing').cov.state, 'passed');
});

test('traffic.api_enumeration', () => {
  const paths = Array.from({ length: 250 }, (_, i) => ({ host: 'api.example.test', path: `/api/orders/${1000 + i}`, status: 200, count: 8 }));
  const r = run(snap({ requests: req(paths) }), 'traffic.api_enumeration');
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].title, /\/api\/orders\/\{id\}/);
  assert.equal(r.findings[0].severity, 'medium');
  assert.equal(run(snap({ requests: req(paths), 'phase:http_ratelimit': [rl('(starts_with(http.request.uri.path, "/api/orders/"))')] }), 'traffic.api_enumeration').findings[0].severity, 'low');
  assert.equal(run(snap({ requests: req(paths.slice(0, 50)) }), 'traffic.api_enumeration').cov.state, 'passed');
});

test('cache.poisoning_headers', () => {
  const cacheAll = [{ id: 'c1', action: 'set_cache_settings', expression: 'true', action_parameters: { cache: true } }];
  const base = { 'phase:http_request_cache_settings': cacheAll, page_rules: [] };
  const r = run(snap({ ...base, 'phase:http_request_late_transform': [] }), 'cache.poisoning_headers');
  assert.equal(r.findings[0].severity, 'medium');
  const strip = [{ id: 't', action: 'rewrite', expression: 'true', action_parameters: { headers: Object.fromEntries(['X-Forwarded-Host', 'X-Original-URL', 'X-Rewrite-URL', 'X-Forwarded-Scheme', 'X-Host'].map((h) => [h, { operation: 'remove' }])) } }];
  assert.equal(run(snap({ ...base, 'phase:http_request_late_transform': strip }), 'cache.poisoning_headers').cov.state, 'passed');
  assert.equal(run(snap({ 'phase:http_request_cache_settings': [], page_rules: [], 'phase:http_request_late_transform': [] }), 'cache.poisoning_headers').cov.state, 'passed');
});

test('posture: every threat and area names rules that exist', () => {
  const ids = new Set(ALL_RULES.map((r) => r.id));
  for (const t of THREATS) for (const id of t.rules) assert.ok(ids.has(id), `${t.id}: ${id}`);
  const groups = new Set(ALL_RULES.map((r) => r.group));
  for (const g of groups) assert.ok(AREAS.some((a) => a.groups.includes(g)), `group ${g} is in an area`);
});

test('posture: unread areas are not graded, and a zone with almost nothing read gets no grade', () => {
  const p = postureOf(report(snap({})));
  assert.equal(p.grade, null);
  assert.ok(p.areas.every((a) => a.rating === 'unknown' || a.rating === 'not_applicable'), JSON.stringify(p.areas.map((a) => [a.id, a.rating, a.read, a.applicable])));
  assert.equal(p.enforcement.enforcedShare, null, 'not measured, never 0');
  assert.match(p.verdict, /could not be graded/);
});

test('posture: plan upgrades only for open gaps', () => {
  const p = postureOf(report(snap({ 'phase:http_request_firewall_managed': [], 'phase:http_request_firewall_custom': [] }, 'free')));
  assert.ok(p.upgrades.every((u) => u.plan === 'Pro' || u.plan === 'Enterprise'));
  const ent = postureOf(report(snap({}, 'enterprise')));
  assert.ok(!ent.upgrades.some((u) => u.plan === 'Enterprise'));
});

test('REPORT.md carries the posture', () => {
  const md = auditMarkdown(report(snap({ requests: req([]), 'setting:ssl': { value: 'strict' } })), 'Castellan');
  for (const h of ['## Posture', '### Scorecard', '### Enforcement in the traffic', '### Threat coverage', '### What to monitor', '### Assumptions and limits']) assert.ok(md.includes(h), h);
  assert.match(md, /Passive only/);
});
