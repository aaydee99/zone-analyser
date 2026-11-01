import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_RULES, buildReport } from '@/lib/zone-audit/report';
import { actionItems } from '@/lib/zone-audit/actions';
import { CF_MANAGED, DDOS_L7, riskyLabel, runRules } from '@/lib/zone-audit/rules';
import { isBroad, isBroadPattern, literalPaths, norm, onlyClientFields, sensitivePaths } from '@/lib/zone-audit/expr';
import { auditCsv, auditMarkdown, findingsJson } from '@/lib/zone-audit/render';
import { MASK, SOURCES, redact, type EventData, type Got, type RequestData, type Snapshot, type SourceKey, type Severity, type Verdict } from '@/lib/zone-audit/types';

// Every audit rule against a clean snapshot (all pass) and a failing one, with the verdict and
// severity it must give, and "not read" when its data is missing. Test data only (example.test,
// documentation address ranges).

const OWASP = '4814384a9e5d4991b9815dcfc25d2f1f';
const NOW = '2026-11-01T00:00:00.000Z';
const days = (n: number) => new Date(Date.parse(NOW) + n * 86_400_000).toISOString();
const ok = <T>(value: T): Got<T> => ({ state: 'ok', value });
const evData = (o: Partial<EventData> = {}): EventData => ({ since: days(-7), until: NOW, rules: [], paths: [], countries: [], asns: [], ips: [], uas: [], statuses: null, hours: null, bots: null, attacks: null, notes: [], ...o });
const rqData = (o: Partial<RequestData> = {}): RequestData => ({ since: days(-7), until: NOW, paths: [], asns: [], notes: [], ...o });

/** A zone where every rule passes. `edit` changes the reads before the snapshot is used. */
function snap(edit: (r: Record<string, unknown>) => void = () => {}, plan = 'business', type = 'full'): Snapshot {
  const r: Record<string, unknown> = {
    zone: { id: 'z1', name: 'example.test', status: 'active', type, plan },
    'setting:ssl': { value: 'strict' }, 'setting:min_tls_version': { value: '1.2' }, 'setting:tls_1_3': { value: 'on' }, 'setting:always_use_https': { value: 'on' },
    'setting:automatic_https_rewrites': { value: 'on' }, 'setting:security_header': { value: { strict_transport_security: { enabled: true, max_age: 31_536_000, include_subdomains: true, nosniff: true, preload: false } } },
    'setting:security_level': { value: 'medium' }, 'setting:browser_check': { value: 'on' }, 'setting:development_mode': { value: 'off' }, 'setting:true_client_ip_header': { value: 'off' }, 'setting:cache_level': { value: 'aggressive' },
    'setting:0rtt': { value: 'off' }, 'setting:opportunistic_encryption': { value: 'on' }, 'setting:email_obfuscation': { value: 'on' }, 'setting:hotlink_protection': { value: 'on' },
    'setting:server_side_exclude': { value: 'on' }, 'setting:challenge_ttl': { value: 1800 }, 'setting:websockets': { value: 'off' }, 'setting:ip_geolocation': { value: 'on' }, 'setting:ssl_automatic_mode': { value: 'custom' },
    'phase:http_response_firewall_managed': [], 'phase:http_config_settings': [],
    access_rules: [], account_access_rules: [], lockdowns: [], ua_rules: [], universal_ssl: { enabled: true }, leaked_credentials: { enabled: true },
    schema_validation: { validation_default_mitigation_action: 'none' }, api_operations: { total: 0 },
    'phase:http_request_firewall_custom': [],
    'phase:http_request_firewall_managed': [{ id: 'm-dep', action: 'execute', expression: 'true', action_parameters: { id: CF_MANAGED } }, { id: 'o-dep', action: 'execute', expression: 'true', action_parameters: { id: OWASP } }],
    'phase:http_ratelimit': [{ id: 'rl1', description: 'Login', action: 'block', expression: '(http.request.uri.path eq "/login")', ratelimit: { characteristics: ['cf.colo.id', 'ip.src', 'http.request.headers["x-session"]'], period: 60, requests_per_period: 5, mitigation_timeout: 600 } }],
    'phase:ddos_l7': [], 'phase:http_request_cache_settings': [], 'phase:http_request_origin': [],
    'phase:http_response_headers_transform': [{ id: 'h1', action: 'rewrite', expression: 'true', action_parameters: { headers: { 'Content-Security-Policy': { operation: 'set', value: "default-src 'self'" } } } }],
    dns: [
      { name: 'example.test', type: 'A', content: '192.0.2.10', proxied: true },
      { name: 'www.example.test', type: 'CNAME', content: 'example.test', proxied: true },
      { name: 'example.test', type: 'TXT', content: '"v=spf1 include:_spf.example.net -all"' },
      { name: '_dmarc.example.test', type: 'TXT', content: '"v=DMARC1; p=reject"' },
      { name: 'example.test', type: 'CAA', content: '0 issue "letsencrypt.org"' },
    ],
    dnssec: { status: 'active' },
    certificates: [{ id: 'p1', type: 'universal', status: 'active', hosts: ['example.test', '*.example.test'], certificates: [{ expires_on: days(60) }] }],
    aop: { enabled: true }, bot: { sbfm_definitely_automated: 'block', sbfm_likely_automated: 'managed_challenge', enable_js: true, fight_mode: true, ai_bots_protection: 'block' }, page_shield: { enabled: true }, page_rules: [], worker_routes: [],
    managed_headers: { managed_response_headers: [{ id: 'add_security_headers', enabled: true }] },
    cname_lookups: { answers: {}, skipped: 0 },
    events: evData({ rules: [{ ruleId: 'rl1', rulesetId: 'rs-rl', source: 'ratelimit', action: 'block', description: 'Login', count: 50 },
      { ruleId: 'm1', rulesetId: CF_MANAGED, source: 'firewallManaged', action: 'block', description: 'SQLi', count: 20 },
      { ruleId: '6179ae15870a4bb7b2d480d4843b323c', rulesetId: OWASP, source: 'firewallManaged', action: 'block', description: '949110', count: 15 }] }),
    events_previous: evData({ rules: [{ ruleId: 'rl1', rulesetId: 'rs-rl', source: 'ratelimit', action: 'block', description: 'Login', count: 25 }] }),
    requests: rqData({ paths: [{ host: 'example.test', path: '/', status: 200, count: 5000 }], asns: [{ asn: '64500', name: 'Example Broadband', status: 200, count: 5000 }] }),
  };
  edit(r);
  const reads: Snapshot['reads'] = {};
  for (const [k, v] of Object.entries(r)) if (v !== undefined) reads[k as SourceKey] = v && typeof v === 'object' && 'state' in v ? v as Got<unknown> : ok(v);
  return { zoneId: 'z1', zoneName: 'example.test', now: NOW, reads, hours: 168, askedHours: 168 };
}

const result = (s: Snapshot, id: string) => {
  const { findings, coverage } = runRules(s, ALL_RULES);
  return { cov: coverage.find((c) => c.ruleId === id)!, findings: findings.filter((f) => f.ruleId === id) };
};
/** The rule finds exactly what is expected (first finding's verdict and severity). */
function fails(id: string, s: Snapshot, verdict: Verdict, severity: Severity, n = 1) {
  const r = result(s, id);
  assert.equal(r.cov.state, 'finding', `${id}: ${JSON.stringify(r.cov)}`);
  assert.equal(r.findings.length, n, `${id}: ${r.findings.map((f) => f.title).join(' | ')}`);
  assert.equal(r.findings[0].verdict, verdict, `${id} verdict`);
  assert.equal(r.findings[0].severity, severity, `${id} severity`);
  for (const f of r.findings) {
    assert.ok(f.fingerprint.startsWith(`zone:z1:${id}`), f.fingerprint);
    assert.ok(f.evidence.length && f.fix.length && f.attackClass && f.skillRef.endsWith('.md'));
    assert.equal(f.validation === null, f.verdict === 'confirmed', `${id}: validation only for needs_validation`);
  }
  return r.findings;
}
const state = (id: string, s: Snapshot) => result(s, id).cov.state;
const set = (k: string, value: unknown) => (r: Record<string, unknown>) => { r[k] = value; };
const setting = (id: string, value: unknown) => set(`setting:${id}`, { value });

/** Rules a Business zone does not get (Free-only, Enterprise-only). */
const PLAN_GATED = ['managed.free_ruleset', 'managed.sensitive_data', 'bots.bm_rules'];

test('the clean zone passes every rule', () => {
  const { findings, coverage } = runRules(snap(), ALL_RULES);
  assert.deepEqual(findings.map((f) => f.title), []);
  assert.deepEqual(coverage.filter((c) => c.state !== 'passed' && !(PLAN_GATED.includes(c.ruleId) && c.state === 'not_applicable')).map((c) => `${c.ruleId}: ${c.state} ${c.reason}`), []);
  assert.equal(coverage.length, ALL_RULES.length);
  assert.equal(new Set(ALL_RULES.map((r) => r.id)).size, ALL_RULES.length, 'rule ids are unique');
});

test('every rule is not_read (with a permission) when its data is missing, never passed', () => {
  for (const rule of ALL_RULES) {
    for (const k of rule.needs) {
      const s = snap((r) => { delete r[k]; });
      const c = result(s, rule.id).cov;
      assert.equal(c.state, 'not_read', `${rule.id} without ${k}`);
      assert.equal(c.permission, SOURCES[k].permission);
      const e = snap(set(k, { state: 'error', status: 403, reason: 'The token cannot read this (Unauthorized)' }));
      assert.equal(result(e, rule.id).cov.state, 'not_read', `${rule.id} with ${k} refused`);
    }
  }
});

test('a product the zone lacks is not_applicable', () => {
  assert.equal(state('client.page_shield', snap(set('page_shield', { state: 'absent', reason: 'not on this plan' }))), 'not_applicable');
  assert.equal(state('traffic.zero_hits', snap(set('events', { state: 'absent', reason: 'not offered' }))), 'not_applicable');
});

// ── Transport ──
test('tls.ssl_mode', () => {
  fails('tls.ssl_mode', snap(setting('ssl', 'flexible')), 'confirmed', 'high');
  fails('tls.ssl_mode', snap(setting('ssl', 'off')), 'confirmed', 'high');
  fails('tls.ssl_mode', snap(setting('ssl', 'full')), 'needs_validation', 'medium');
});
test('tls.min_version and tls.tls13', () => {
  fails('tls.min_version', snap(setting('min_tls_version', '1.0')), 'confirmed', 'medium');
  assert.equal(state('tls.min_version', snap(setting('min_tls_version', '1.3'))), 'passed');
  fails('tls.tls13', snap(setting('tls_1_3', 'off')), 'confirmed', 'low');
  assert.equal(state('tls.tls13', snap(setting('tls_1_3', 'zrt'))), 'passed');
});
test('tls.always_https and tls.https_rewrites', () => {
  fails('tls.always_https', snap(setting('always_use_https', 'off')), 'needs_validation', 'medium');
  assert.equal(state('tls.always_https', snap((r) => { setting('always_use_https', 'off')(r); setting('ssl', 'off')(r); })), 'not_applicable');
  fails('tls.https_rewrites', snap(setting('automatic_https_rewrites', 'off')), 'needs_validation', 'low');
});
test('tls.hsts', () => {
  fails('tls.hsts', snap(setting('security_header', { strict_transport_security: { enabled: false } })), 'needs_validation', 'medium');
  const viaRule = snap((r) => { setting('security_header', { strict_transport_security: { enabled: false } })(r); r['phase:http_response_headers_transform'] = [{ action: 'rewrite', action_parameters: { headers: { 'Strict-Transport-Security': { operation: 'set', value: 'max-age=31536000' } } } }]; });
  assert.equal(state('tls.hsts', viaRule), 'passed');
  fails('tls.hsts', snap(setting('security_header', { strict_transport_security: { enabled: true, max_age: 86_400, include_subdomains: true } })), 'confirmed', 'low');
  fails('tls.hsts', snap(setting('security_header', { strict_transport_security: { enabled: true, max_age: 600, include_subdomains: false } })), 'confirmed', 'low', 2);
});
test('tls.origin_pulls', () => {
  fails('tls.origin_pulls', snap(set('aop', { enabled: false })), 'needs_validation', 'medium');
  assert.equal(state('tls.origin_pulls', snap((r) => { r.aop = { enabled: false }; setting('ssl', 'flexible')(r); })), 'not_applicable');
});
test('tls.certificates', () => {
  const pack = (o: object) => set('certificates', [{ id: 'p1', type: 'universal', status: 'active', hosts: ['example.test'], certificates: [{ expires_on: days(60) }], ...o }]);
  fails('tls.certificates', snap(pack({ certificates: [{ expires_on: days(-1) }] })), 'confirmed', 'high');
  fails('tls.certificates', snap(pack({ certificates: [{ expires_on: days(5) }] })), 'needs_validation', 'medium');
  fails('tls.certificates', snap(pack({ status: 'pending_validation' })), 'needs_validation', 'medium');
  assert.equal(state('tls.certificates', snap(pack({ status: 'deleted', certificates: [{ expires_on: days(-9) }] }))), 'passed');
});

// ── Origin ──
const addDns = (...recs: object[]) => (r: Record<string, unknown>) => { r.dns = [...(r.dns as object[]), ...recs]; };
test('origin.leak', () => {
  fails('origin.leak', snap(addDns({ name: 'mail.example.test', type: 'A', content: '192.0.2.10', proxied: false })), 'confirmed', 'high');
  assert.equal(state('origin.leak', snap(addDns({ name: 'mail.example.test', type: 'A', content: '203.0.113.9', proxied: false }))), 'passed');
});
test('origin.risky_names', () => {
  fails('origin.risky_names', snap(addDns({ name: 'jenkins.example.test', type: 'A', content: '198.51.100.7', proxied: false })), 'needs_validation', 'medium');
  fails('origin.risky_names', snap(addDns({ name: 'staging2.example.test', type: 'CNAME', content: 'host.example.net', proxied: false })), 'needs_validation', 'medium');
  assert.equal(state('origin.risky_names', snap(addDns({ name: 'jenkins.example.test', type: 'A', content: '198.51.100.7', proxied: true }))), 'passed');
  assert.equal(state('origin.risky_names', snap(addDns({ name: 'internal.example.test', type: 'A', content: '10.0.0.5', proxied: false }))), 'passed', 'private addresses are not reachable');
  assert.equal(riskyLabel('a.dev.example.test', 'example.test'), 'dev');
  assert.equal(riskyLabel('developer.example.test', 'example.test'), null);
});
test('origin.dangling_cname', () => {
  const s = snap((r) => {
    addDns({ name: 'old.example.test', type: 'CNAME', content: 'gone-app.azurewebsites.net', proxied: false }, { name: 'ext.example.test', type: 'CNAME', content: 'nothing.example.net', proxied: true })(r);
    r.cname_lookups = { answers: { 'gone-app.azurewebsites.net': 3, 'nothing.example.net': 3 }, skipped: 0 };
  });
  const f = fails('origin.dangling_cname', s, 'confirmed', 'high', 2);
  assert.equal(f[1].verdict, 'needs_validation');
  assert.equal(f[1].severity, 'medium');
  assert.equal(state('origin.dangling_cname', snap((r) => { addDns({ name: 'old.example.test', type: 'CNAME', content: 'app.azurewebsites.net' })(r); r.cname_lookups = { answers: { 'app.azurewebsites.net': 0 }, skipped: 0 }; })), 'passed');
});
test('origin.wildcard', () => {
  fails('origin.wildcard', snap(addDns({ name: '*.example.test', type: 'A', content: '192.0.2.10', proxied: true })), 'needs_validation', 'info');
});

// ── Email and DNS ──
const dnsWithout = (pred: (r: { type: string; name: string; content: string }) => boolean, ...extra: object[]) => (r: Record<string, unknown>) => {
  r.dns = [...(r.dns as { type: string; name: string; content: string }[]).filter((x) => !pred(x)), ...extra];
};
test('email.spf', () => {
  const noSpf = (x: { content: string }) => x.content.includes('v=spf1');
  fails('email.spf', snap(dnsWithout(noSpf)), 'needs_validation', 'medium');
  fails('email.spf', snap(dnsWithout(noSpf, { name: 'example.test', type: 'TXT', content: 'v=spf1 +all' })), 'confirmed', 'high');
  fails('email.spf', snap(dnsWithout(noSpf, { name: 'example.test', type: 'TXT', content: 'v=spf1 ?all' })), 'confirmed', 'medium');
  fails('email.spf', snap(addDns({ name: 'example.test', type: 'TXT', content: 'v=spf1 -all' })), 'confirmed', 'medium');
  assert.equal(state('email.spf', snap(dnsWithout(noSpf), 'business', 'partial')), 'not_applicable');
});
test('email.dmarc, email.caa and dns.dnssec', () => {
  const dmarc = (x: { name: string }) => x.name.startsWith('_dmarc');
  fails('email.dmarc', snap(dnsWithout(dmarc)), 'confirmed', 'medium');
  fails('email.dmarc', snap(dnsWithout(dmarc, { name: '_dmarc.example.test', type: 'TXT', content: 'v=DMARC1; p=none; rua=mailto:dmarc@example.test' })), 'confirmed', 'low');
  fails('email.caa', snap(dnsWithout((x) => x.type === 'CAA')), 'confirmed', 'low');
  fails('dns.dnssec', snap(set('dnssec', { status: 'disabled' })), 'confirmed', 'low');
});

// ── WAF ──
const custom = (...rules: object[]) => set('phase:http_request_firewall_custom', rules);
test('waf.managed_ruleset and waf.owasp', () => {
  fails('waf.managed_ruleset', snap(set('phase:http_request_firewall_managed', [{ action: 'execute', action_parameters: { id: OWASP } }])), 'confirmed', 'high');
  fails('waf.managed_ruleset', snap(set('phase:http_request_firewall_managed', [{ action: 'execute', enabled: false, action_parameters: { id: CF_MANAGED } }, { action: 'execute', action_parameters: { id: OWASP } }])), 'confirmed', 'high');
  assert.equal(state('waf.managed_ruleset', snap(set('phase:http_request_firewall_managed', []), 'free')), 'not_applicable');
  fails('waf.owasp', snap(set('phase:http_request_firewall_managed', [{ action: 'execute', action_parameters: { id: CF_MANAGED } }])), 'confirmed', 'medium');
  fails('waf.owasp', snap(set('phase:http_request_firewall_managed', [{ action: 'execute', action_parameters: { id: CF_MANAGED } }, { action: 'execute', action_parameters: { id: OWASP, overrides: { action: 'log' } } }])), 'confirmed', 'medium');
});
test('waf.broad_skip, waf.header_skip and waf.disabled_rules', () => {
  fails('waf.broad_skip', snap(custom({ id: 's1', description: 'Skip all', action: 'skip', expression: 'true', action_parameters: { ruleset: 'current' } })), 'confirmed', 'high');
  fails('waf.broad_skip', snap(custom({ id: 's1', action: 'skip', expression: '(http.host eq "example.test")', action_parameters: { phases: ['http_request_firewall_managed'] } })), 'confirmed', 'high');
  assert.equal(state('waf.broad_skip', snap(custom({ id: 's1', action: 'skip', expression: '(ip.src in $partners and starts_with(http.request.uri.path, "/hook/"))', action_parameters: { ruleset: 'current' } }))), 'passed');
  fails('waf.header_skip', snap(custom({ id: 's2', action: 'skip', expression: '(any(http.request.headers["x-bypass"][*] eq "1"))', action_parameters: { ruleset: 'current' } })), 'needs_validation', 'high');
  assert.equal(state('waf.header_skip', snap(custom({ id: 's2', action: 'skip', expression: '(ip.src eq 192.0.2.1 and any(http.request.headers["x-bypass"][*] eq "1"))', action_parameters: { ruleset: 'current' } }))), 'passed');
  fails('waf.disabled_rules', snap(custom({ id: 'c1', action: 'block', expression: '(http.request.uri.path eq "/x")', enabled: false })), 'confirmed', 'info');
});
test('waf.security_level, waf.browser_check and waf.bot_fight', () => {
  fails('waf.security_level', snap(setting('security_level', 'off')), 'confirmed', 'medium');
  fails('waf.security_level', snap(setting('security_level', 'essentially_off')), 'confirmed', 'low');
  fails('waf.security_level', snap(setting('security_level', 'under_attack')), 'confirmed', 'info');
  fails('waf.browser_check', snap(setting('browser_check', 'off')), 'confirmed', 'low');
  fails('waf.bot_fight', snap(set('bot', { sbfm_definitely_automated: 'allow' })), 'confirmed', 'low');
  fails('waf.bot_fight', snap(set('bot', { fight_mode: false }), 'free'), 'confirmed', 'low');
  assert.equal(state('waf.bot_fight', snap(set('bot', {}), 'enterprise')), 'not_applicable');
});

// ── Availability ──
test('avail.rate_limits, avail.ddos_overrides and avail.dev_mode', () => {
  fails('avail.rate_limits', snap(set('phase:http_ratelimit', [])), 'needs_validation', 'medium');
  fails('avail.ddos_overrides', snap(set('phase:ddos_l7', [{ id: 'd1', action: 'execute', expression: 'true', action_parameters: { id: DDOS_L7, overrides: { sensitivity_level: 'eoff' } } }])), 'confirmed', 'high');
  fails('avail.ddos_overrides', snap(set('phase:ddos_l7', [{ id: 'd1', action: 'execute', expression: 'true', action_parameters: { id: DDOS_L7, overrides: { rules: [{ id: 'r9', action: 'log' }] } } }])), 'confirmed', 'high');
  fails('avail.ddos_overrides', snap(set('phase:ddos_l7', [{ id: 'd1', action: 'execute', expression: 'true', action_parameters: { id: DDOS_L7, overrides: { sensitivity_level: 'medium' } } }])), 'confirmed', 'low');
  fails('avail.dev_mode', snap(setting('development_mode', 'on')), 'confirmed', 'medium');
});

// ── Cache ──
const cacheRule = (o: object) => set('phase:http_request_cache_settings', [{ id: 'k1', description: 'Cache', action: 'set_cache_settings', ...o }]);
test('cache.private_caching', () => {
  fails('cache.private_caching', snap(cacheRule({ expression: 'starts_with(http.request.uri.path, "/account")', action_parameters: { cache: true, edge_ttl: { mode: 'override_origin', default: 3600 }, cache_key: { cache_deception_armor: true } } })), 'confirmed', 'high');
  fails('cache.private_caching', snap(cacheRule({ expression: 'true', action_parameters: { cache: true, cache_key: { cache_deception_armor: true } } })), 'needs_validation', 'medium');
  fails('cache.private_caching', snap(set('page_rules', [{ id: 'pr1', status: 'active', targets: [{ constraint: { value: 'example.test/api/*' } }], actions: [{ id: 'cache_level', value: 'cache_everything' }, { id: 'cache_deception_armor', value: 'on' }] }])), 'needs_validation', 'high');
  assert.equal(state('cache.private_caching', snap(cacheRule({ expression: 'http.request.uri.path.extension eq "css"', action_parameters: { cache: true, cache_key: { cache_deception_armor: true } } }))), 'passed');
});
test('cache.deception_armor and cache.unkeyed_query', () => {
  fails('cache.deception_armor', snap(cacheRule({ expression: 'http.request.uri.path.extension eq "css"', action_parameters: { cache: true } })), 'needs_validation', 'medium');
  fails('cache.unkeyed_query', snap(setting('cache_level', 'simplified')), 'needs_validation', 'medium');
  fails('cache.unkeyed_query', snap(cacheRule({ expression: 'true', action_parameters: { cache: true, cache_key: { custom_key: { query_string: { exclude: { all: true } } } } } })), 'needs_validation', 'medium');
});

// ── Host, client, edge ──
test('host rules', () => {
  fails('host.origin_overrides', snap(set('phase:http_request_origin', [{ id: 'o1', action: 'route', expression: 'true', action_parameters: { host_header: 'origin.example.net' } }])), 'needs_validation', 'low');
  fails('host.true_client_ip', snap(setting('true_client_ip_header', 'on')), 'needs_validation', 'info');
});
test('client rules', () => {
  const f = fails('client.security_headers', snap((r) => { r['phase:http_response_headers_transform'] = []; r.managed_headers = { managed_response_headers: [] }; setting('security_header', { strict_transport_security: { enabled: true, max_age: 31_536_000, include_subdomains: true } })(r); }), 'needs_validation', 'low');
  assert.match(f[0].title, /content-security-policy, x-frame-options, x-content-type-options/);
  fails('client.page_shield', snap(set('page_shield', { enabled: false })), 'confirmed', 'low');
});
test('edge.worker_routes', () => {
  const f = fails('edge.worker_routes', snap(set('worker_routes', [{ id: 'w1', pattern: 'example.test/*', script: 'gate' }, { id: 'w2', pattern: 'example.test/admin/*', script: null }])), 'needs_validation', 'medium', 2);
  assert.equal(f[1].severity, 'info');
});

// ── Traffic ──
const events = (o: Partial<EventData>) => set('events', evData(o));
const rl = { ruleId: 'rl1', rulesetId: 'rs-rl', source: 'ratelimit', action: 'block', description: 'Login', count: 50 };
test('traffic.zero_hits and traffic.ratelimit_unused', () => {
  fails('traffic.zero_hits', snap(events({ rules: [] })), 'confirmed', 'info');
  const day = snap(events({ rules: [] })); day.hours = 24;
  assert.equal(result(day, 'traffic.zero_hits').findings[0].verdict, 'needs_validation', 'a day of sampled events proves less');
  fails('traffic.ratelimit_unused', snap((r) => { events({ rules: [] })(r); r.requests = rqData({ paths: [{ host: 'example.test', path: '/login', status: 200, count: 20_000 }] }); }), 'needs_validation', 'low');
});
test('traffic.false_positive reuses the WAF false-positive score and draft', () => {
  const ips = Array.from({ length: 60 }, (_, i) => ({ ruleId: 'c2', source: 'firewallCustom', action: 'managed_challenge', ip: `198.51.100.${i + 1}`, count: 5 }));
  const asns = Array.from({ length: 10 }, (_, i) => ({ ruleId: 'c2', source: 'firewallCustom', action: 'managed_challenge', asn: String(64500 + i), name: `Example Broadband ${i}`, count: 30 }));
  const f = fails('traffic.false_positive', snap((r) => {
    custom({ id: 'c2', description: 'Challenge checkout', action: 'managed_challenge', expression: '(http.request.uri.path eq "/checkout")' })(r);
    events({ rules: [rl, { ruleId: 'c2', rulesetId: 'rs-c', source: 'firewallCustom', action: 'managed_challenge', description: 'Challenge checkout', count: 300 }, { ruleId: 'c2', rulesetId: 'rs-c', source: 'firewallCustom', action: 'challenge_solved', description: 'Challenge checkout', count: 200 }],
      ips, asns, uas: [{ ruleId: 'c2', source: 'firewallCustom', action: 'managed_challenge', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', count: 300 }],
      paths: [{ ruleId: 'c2', source: 'firewallCustom', action: 'managed_challenge', host: 'example.test', path: '/checkout', count: 300 }] })(r);
  }), 'needs_validation', 'medium');
  assert.ok(f[0].fix.some((x) => x.includes('http.request.uri.path eq "/checkout"')), f[0].fix.join('\n'));
});
test('traffic.managed_log', () => {
  fails('traffic.managed_log', snap(events({ rules: [rl, { ruleId: 'm1', rulesetId: CF_MANAGED, source: 'firewallManaged', action: 'log', description: 'SQLi', count: 150 }] })), 'confirmed', 'medium');
});
test('traffic.unmitigated_paths and traffic.unmitigated_networks', () => {
  fails('traffic.unmitigated_paths', snap(set('requests', rqData({ paths: [{ host: 'example.test', path: '/wp-login.php', status: 404, count: 4000 }, { host: 'example.test', path: '/wp-login.php', status: 200, count: 1000 }] }))), 'needs_validation', 'medium');
  fails('traffic.unmitigated_networks', snap(set('requests', rqData({ asns: [{ asn: '16509', name: 'AMAZON-02', status: 403, count: 6000 }, { asn: '64500', name: 'Example Broadband', status: 200, count: 4000 }] }))), 'needs_validation', 'medium');
});

test('the effectiveness table: per-rule counts, solve rate and trend', () => {
  const s = snap(events({ rules: [rl, { ...rl, action: 'managed_challenge', count: 40 }, { ...rl, action: 'challenge_solved', count: 10 }] }));
  const r = buildReport(s, { accountId: 'a1', accountName: 'Test', startedAt: NOW, finishedAt: NOW, calls: 30, lookups: 0 });
  const row = r.effectiveness!.rules.find((x) => x.ruleId === 'rl1')!;
  assert.equal(row.events, 100);
  assert.equal(row.configured, true);
  assert.equal(row.solveRate, 0.25);
  assert.equal(row.trend, 3, '(100 - 25) / 25');
  assert.equal(r.summary.rules, ALL_RULES.length);
});

// ── Helpers, redaction, renderers ──
test('expression helpers', () => {
  assert.equal(norm('((true))'), 'true');
  assert.equal(norm('(a) and (b)'), '(a) and (b)');
  assert.ok(isBroad('(http.host eq "example.test")') && isBroad('true') && isBroad('(starts_with(http.request.uri.path, "/") and http.host eq "a.test")'));
  assert.ok(!isBroad('(http.request.uri.path eq "/x")') && !isBroad(''));
  assert.deepEqual(sensitivePaths('starts_with(http.request.uri.path, "/api/") or http.request.uri.path eq "/login"'), ['/api', '/login']);
  assert.deepEqual(sensitivePaths('/apiary/x'), []);
  assert.ok(isBroadPattern('example.test/*') && isBroadPattern('*.example.test/*') && !isBroadPattern('example.test/admin/*'));
  assert.ok(onlyClientFields('http.user_agent contains "x"') && !onlyClientFields('ip.src eq 192.0.2.1 and http.user_agent contains "x"'));
  assert.deepEqual(literalPaths('(http.request.uri.path eq "/login" or starts_with(http.request.uri.path, "/api/"))').map((p) => p.how), ['eq', 'prefix']);
});
test('redaction', () => {
  assert.equal(redact('authorization', 'Bearer abc'), MASK);
  assert.equal(redact('url', 'https://example.test/x?token=abc&y=1'), `https://example.test/x?token=${MASK}&y=1`);
  assert.match(redact('x', 'a'.repeat(500)), /… \(500 characters\)$/);
});
test('renderers: findings.json, REPORT.md and CSV', () => {
  const r = buildReport(snap((x) => { setting('ssl', 'flexible')(x); delete x.bot; }), { accountId: 'a1', accountName: 'Test', startedAt: NOW, finishedAt: NOW, calls: 31, lookups: 2 });
  const json = JSON.parse(findingsJson(r));
  assert.equal(json[0].ruleId, 'tls.ssl_mode');
  const md = auditMarkdown(r, 'Castellan');
  for (const h of ['## Summary', '## Findings', '## Recommended actions', '## Effectiveness', '## Managed ruleset', '## Coverage ledger', '## Method']) assert.ok(md.includes(h), h);
  assert.match(md, /rules could not be checked/);
  assert.match(md, /needs permission: Bot Management Read/);
  const csv = auditCsv({ ...r, findings: [{ ...r.findings[0], title: '=HYPERLINK("x")' }] }, 'findings');
  assert.match(csv, /'=HYPERLINK/);
  assert.equal(auditCsv(r, 'coverage').trim().split('\r\n').length, ALL_RULES.length + 1);
});

// ── Managed rules in depth ──
const FREE = '77454fe2d30c4220b5701f6fdfb893ba', ECC = 'c2e184081120413c86c3ab7e14069605', SDD = 'e22d83c647c64a3eae91b71b499d988e', ANOMALY = '6179ae15870a4bb7b2d480d4843b323c';
const managed = (...rules: object[]) => set('phase:http_request_firewall_managed', rules);
const cfDep = (o: object = {}) => ({ id: 'm-dep', action: 'execute', expression: 'true', action_parameters: { id: CF_MANAGED, ...o } });
const owDep = (o: object = {}) => ({ id: 'o-dep', action: 'execute', expression: 'true', action_parameters: { id: OWASP, ...o } });
test('managed.cf_overrides', () => {
  fails('managed.cf_overrides', snap(managed(cfDep({ overrides: { action: 'log' } }), owDep())), 'confirmed', 'high');
  fails('managed.cf_overrides', snap(managed(cfDep({ overrides: { categories: [{ category: 'wordpress', enabled: false }], rules: [{ id: 'r1', action: 'log' }] } }), owDep())), 'confirmed', 'medium');
  fails('managed.cf_overrides', snap(managed({ ...cfDep(), expression: '(http.host eq "a.example.test" and http.request.uri.path eq "/x")' }, owDep())), 'needs_validation', 'medium');
  assert.equal(state('managed.cf_overrides', snap(managed(owDep()))), 'not_applicable');
});
test('managed.owasp_tuning', () => {
  const pl1 = [{ category: 'paranoia-level-2', enabled: false }, { category: 'paranoia-level-3', enabled: false }, { category: 'paranoia-level-4', enabled: false }];
  fails('managed.owasp_tuning', snap(managed(cfDep(), owDep({ overrides: { categories: pl1, rules: [{ id: ANOMALY, score_threshold: 60 }] } }))), 'confirmed', 'medium');
  fails('managed.owasp_tuning', snap(managed(cfDep(), owDep({ overrides: { categories: [{ category: 'paranoia-level-4', enabled: false }], rules: [{ id: ANOMALY, score_threshold: 60 }] } }))), 'confirmed', 'low');
  fails('managed.owasp_tuning', snap(managed(cfDep(), owDep({ overrides: { categories: [{ category: 'language-php', enabled: false }] } }))), 'confirmed', 'low');
  assert.equal(state('managed.owasp_tuning', snap(managed(cfDep(), owDep({ overrides: { rules: [{ id: ANOMALY, score_threshold: 25 }] } })))), 'passed');
});
test('managed.free_ruleset (Free plan only)', () => {
  fails('managed.free_ruleset', snap(managed(), 'free'), 'needs_validation', 'medium');
  fails('managed.free_ruleset', snap(managed({ action: 'execute', enabled: false, action_parameters: { id: FREE } }), 'free'), 'confirmed', 'medium');
  assert.equal(state('managed.free_ruleset', snap(managed({ action: 'execute', action_parameters: { id: FREE } }), 'free')), 'passed');
});
test('managed.leaked_credentials', () => {
  fails('managed.leaked_credentials', snap((r) => { r.leaked_credentials = { enabled: false }; r.requests = rqData({ paths: [{ host: 'example.test', path: '/login', status: 200, count: 500 }] }); }), 'needs_validation', 'medium');
  fails('managed.leaked_credentials', snap(set('leaked_credentials', { enabled: false })), 'needs_validation', 'info');
  assert.equal(state('managed.leaked_credentials', snap((r) => { r.leaked_credentials = { enabled: false }; managed(cfDep(), owDep(), { action: 'execute', action_parameters: { id: ECC } })(r); })), 'passed', 'the (deprecated) Exposed Credentials Check counts');
});
test('managed.sensitive_data (Enterprise only)', () => {
  fails('managed.sensitive_data', snap(set('bot', {}), 'enterprise'), 'needs_validation', 'info');
  assert.equal(state('managed.sensitive_data', snap(set('phase:http_response_firewall_managed', [{ action: 'execute', action_parameters: { id: SDD } }]), 'enterprise')), 'passed');
  assert.equal(state('managed.sensitive_data', snap()), 'not_applicable');
});
test('managed.exceptions', () => {
  const skip = (o: object) => ({ id: 'x1', description: 'Exception', action: 'skip', ...o });
  fails('managed.exceptions', snap(managed(skip({ expression: 'true', action_parameters: { ruleset: 'current' } }), cfDep(), owDep())), 'confirmed', 'high');
  fails('managed.exceptions', snap(managed(skip({ expression: '(http.request.uri.path eq "/upload")', action_parameters: { rulesets: [CF_MANAGED] } }), cfDep(), owDep())), 'confirmed', 'medium');
  fails('managed.exceptions', snap(managed(skip({ expression: '(http.request.uri.path eq "/upload")', action_parameters: { rules: { [CF_MANAGED]: Array.from({ length: 12 }, (_, i) => `r${i}`) } } }), cfDep(), owDep())), 'confirmed', 'low');
  fails('managed.exceptions', snap(managed(cfDep(), owDep(), skip({ expression: '(http.request.uri.path eq "/upload")', action_parameters: { rules: { [CF_MANAGED]: ['r1'] } } }))), 'confirmed', 'info');
  assert.equal(state('managed.exceptions', snap(managed(skip({ expression: '(http.request.uri.path eq "/upload")', action_parameters: { rules: { [CF_MANAGED]: ['r1'] } } }), cfDep(), owDep()))), 'passed');
});
test('managed.all_disabled', () => {
  fails('managed.all_disabled', snap(managed(cfDep(), owDep(), { action: 'execute', enabled: false, action_parameters: { id: ECC } })), 'confirmed', 'medium');
});

// ── Rules that switch security off ──
const allow = (o: object) => ({ id: 'a1', mode: 'whitelist', notes: 'test', ...o });
test('bypass.ip_access_allow and bypass.account_ip_access_allow', () => {
  fails('bypass.ip_access_allow', snap(set('access_rules', [allow({ configuration: { target: 'country', value: 'NL' } })])), 'confirmed', 'high');
  fails('bypass.ip_access_allow', snap(set('access_rules', [allow({ configuration: { target: 'ip_range', value: '198.51.0.0/16' } })])), 'confirmed', 'high');
  assert.equal(state('bypass.ip_access_allow', snap(set('access_rules', [allow({ configuration: { target: 'ip', value: '192.0.2.1' } }), allow({ id: 'a2', configuration: { target: 'country', value: 'NL' }, paused: true })]))), 'passed');
  fails('bypass.ip_access_allow', snap(set('access_rules', Array.from({ length: 500 }, (_, i) => ({ id: `b${i}`, mode: 'block', configuration: { target: 'ip', value: `198.51.100.${i % 250}` } })))), 'confirmed', 'info');
  fails('bypass.account_ip_access_allow', snap(set('account_access_rules', [allow({ configuration: { target: 'asn', value: 'AS64500' } })])), 'confirmed', 'high');
});
test('bypass.config_rules and bypass.page_rules', () => {
  fails('bypass.config_rules', snap(set('phase:http_config_settings', [{ id: 'cfg1', action: 'set_config', expression: 'starts_with(http.request.uri.path, "/api")', action_parameters: { security_level: 'essentially_off' } }])), 'confirmed', 'high');
  fails('bypass.config_rules', snap(set('phase:http_config_settings', [{ id: 'cfg1', action: 'set_config', expression: 'true', action_parameters: { bic: false } }])), 'confirmed', 'medium');
  assert.equal(state('bypass.config_rules', snap(set('phase:http_config_settings', [{ id: 'cfg1', action: 'set_config', expression: 'true', action_parameters: { rocket_loader: false } }]))), 'passed');
  fails('bypass.page_rules', snap(set('page_rules', [{ id: 'pr1', status: 'active', targets: [{ constraint: { value: 'example.test/*' } }], actions: [{ id: 'disable_security' }] }])), 'confirmed', 'high');
  fails('bypass.page_rules', snap(set('page_rules', [{ id: 'pr1', status: 'active', targets: [{ constraint: { value: 'example.test/x/*' } }], actions: [{ id: 'browser_check', value: 'off' }] }])), 'confirmed', 'medium');
});
test('bypass.lockdowns, bypass.ua_rules, waf.custom_log_only', () => {
  fails('bypass.lockdowns', snap(set('lockdowns', [{ id: 'l1', paused: true, description: 'Admin', urls: ['example.test/admin/*'] }])), 'confirmed', 'low');
  assert.equal(state('bypass.lockdowns', snap(set('lockdowns', { state: 'absent', reason: 'not on this plan' }))), 'not_applicable');
  fails('bypass.ua_rules', snap(set('ua_rules', [{ id: 'u1', paused: true, mode: 'block' }])), 'confirmed', 'info');
  fails('waf.custom_log_only', snap(custom({ id: 'c1', action: 'log', expression: '(http.request.uri.path eq "/x")' })), 'confirmed', 'info');
});

// ── Bots, rate limiting, settings, API ──
test('bots rules', () => {
  fails('bots.sbfm_config', snap(set('bot', { sbfm_definitely_automated: 'block', sbfm_likely_automated: 'allow', enable_js: true })), 'confirmed', 'low');
  fails('bots.sbfm_config', snap(set('bot', { sbfm_definitely_automated: 'block', sbfm_likely_automated: 'block', enable_js: true, sbfm_verified_bots: 'block' })), 'confirmed', 'info');
  const bm = { using_latest_model: true, enable_js: true };
  fails('bots.bm_rules', snap(set('bot', bm), 'enterprise'), 'needs_validation', 'medium');
  fails('bots.bm_rules', snap((r) => { r.bot = bm; custom({ id: 'b1', action: 'block', expression: '(cf.bot_management.score lt 2)' })(r); }, 'enterprise'), 'needs_validation', 'low');
  assert.equal(state('bots.bm_rules', snap((r) => { r.bot = bm; custom({ id: 'b1', action: 'managed_challenge', expression: '(cf.bot_management.score lt 30)' })(r); }, 'enterprise')), 'passed');
  assert.equal(state('bots.bm_rules', snap(set('bot', { sbfm_definitely_automated: 'block' }), 'enterprise')), 'not_applicable', 'no Bot Management, no scores');
  fails('bots.ai_bots', snap(set('bot', { sbfm_definitely_automated: 'block', sbfm_likely_automated: 'block', enable_js: true, ai_bots_protection: 'disabled' })), 'confirmed', 'info');
});
test('avail.ratelimit_depth', () => {
  const rlRule = (o: object) => set('phase:http_ratelimit', [{ id: 'rl1', description: 'Login', action: 'block', expression: '(http.request.uri.path eq "/login")', ratelimit: { characteristics: ['cf.colo.id', 'ip.src', 'http.request.headers["x-session"]'], period: 60, requests_per_period: 5, mitigation_timeout: 600 }, ...o }]);
  fails('avail.ratelimit_depth', snap(rlRule({ action: 'log' })), 'confirmed', 'medium');
  fails('avail.ratelimit_depth', snap(rlRule({ ratelimit: { characteristics: ['cf.colo.id', 'ip.src'], period: 60, requests_per_period: 5, mitigation_timeout: 600 } })), 'needs_validation', 'low');
  fails('avail.ratelimit_depth', snap(rlRule({ ratelimit: { characteristics: ['cf.colo.id', 'ip.src', 'cf.unique_visitor_id'], period: 10, requests_per_period: 5, mitigation_timeout: 10 } })), 'confirmed', 'low');
  fails('avail.ratelimit_depth', snap(rlRule({ enabled: false })), 'confirmed', 'info');
});
test('the remaining settings', () => {
  fails('tls.0rtt', snap(setting('0rtt', 'on')), 'needs_validation', 'low');
  fails('tls.opportunistic_encryption', snap(setting('opportunistic_encryption', 'off')), 'confirmed', 'info');
  fails('client.email_obfuscation', snap(setting('email_obfuscation', 'off')), 'confirmed', 'info');
  fails('client.hotlink_protection', snap(setting('hotlink_protection', 'off')), 'confirmed', 'info');
  fails('client.server_side_exclude', snap(setting('server_side_exclude', 'off')), 'confirmed', 'info');
  fails('waf.challenge_ttl', snap(setting('challenge_ttl', 31_536_000)), 'confirmed', 'low');
  fails('edge.websockets', snap(setting('websockets', 'on')), 'needs_validation', 'info');
  fails('waf.ip_geolocation', snap(setting('ip_geolocation', 'off')), 'confirmed', 'info');
  fails('tls.automatic_mode', snap(setting('ssl_automatic_mode', 'auto')), 'confirmed', 'info');
  fails('tls.universal_ssl', snap(set('universal_ssl', { enabled: false })), 'confirmed', 'high');
  assert.equal(state('tls.universal_ssl', snap((r) => { r.universal_ssl = { enabled: false }; r.certificates = [{ id: 'adv', type: 'advanced', status: 'active', hosts: ['example.test'], certificates: [{ expires_on: days(60) }] }]; })), 'passed');
});
test('api.shield', () => {
  const apiTraffic = set('requests', rqData({ paths: [{ host: 'example.test', path: '/api/v1/orders', status: 200, count: 8000 }, { host: 'example.test', path: '/', status: 200, count: 2000 }] }));
  fails('api.shield', snap(apiTraffic), 'needs_validation', 'info');
  assert.equal(state('api.shield', snap((r) => { apiTraffic(r); r.api_operations = { total: 12 }; r.schema_validation = { validation_default_mitigation_action: 'block' }; })), 'passed');
  assert.equal(state('api.shield', snap(set('schema_validation', { state: 'absent', reason: 'API Shield is not on this plan' }))), 'not_applicable');
});

// ── Traffic it let through ──
const PY = 'python-requests/2.31', CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const rowOf = (s: Snapshot, ruleId: string) => buildReport(s, { accountId: 'a1', accountName: 'Test', startedAt: NOW, finishedAt: NOW, calls: 0, lookups: 0 }).effectiveness!.rules.find((x) => x.ruleId === ruleId)!;
const logRule = (count: number, ua: string, asn = { asn: '16509', name: 'AMAZON-02' }) => (r: Record<string, unknown>) => {
  custom({ id: 'c1', description: 'Watch', action: 'log', expression: '(http.request.uri.path contains "/shop")' })(r);
  events({ rules: [rl, { ruleId: 'c1', rulesetId: 'rs-c', source: 'firewallCustom', action: 'log', description: 'Watch', count }],
    asns: [{ ruleId: 'c1', source: 'firewallCustom', action: 'log', ...asn, count }], uas: [{ ruleId: 'c1', source: 'firewallCustom', action: 'log', ua, count }],
    paths: [{ ruleId: 'c1', source: 'firewallCustom', action: 'log', host: 'example.test', path: '/shop/cart', count }] })(r);
};
test('traffic.passthrough: a log rule letting mostly bots through → switch to a challenge (heuristic: needs validation)', () => {
  const s = snap(logRule(400, PY));
  const f = fails('traffic.passthrough', s, 'needs_validation', 'medium');
  assert.match(f[0].title, /400 automated/);
  const p = rowOf(s, 'c1').passthrough!;
  assert.equal(p.verdict, 'bots');
  assert.equal(p.botBasis, 'heuristic');
  assert.equal(p.recommendation.action, 'block_or_challenge');
  assert.match(p.recommendation.title, /from Log to Managed Challenge/);
  assert.equal(p.recommendation.fingerprint, f[0].fingerprint);
});
test('traffic.passthrough: a clean log rule → no action', () => {
  const s = snap(logRule(400, CHROME_UA, { asn: '64500', name: 'Example Broadband' }));
  assert.equal(state('traffic.passthrough', s), 'passed');
  const p = rowOf(s, 'c1').passthrough!;
  assert.equal(p.verdict, 'clean');
  assert.equal(p.recommendation.action, 'keep');
});
test('traffic.passthrough: a small sample → no conclusion', () => {
  const s = snap(logRule(50, PY));
  assert.equal(state('traffic.passthrough', s), 'passed');
  assert.equal(rowOf(s, 'c1').passthrough!.recommendation.action, 'no_conclusion');
});
test('traffic.passthrough: a skip rule letting attack-scored traffic through → narrow (scores: confirmed)', () => {
  const s = snap((r) => {
    custom({ id: 's1', description: 'Skip partner', action: 'skip', expression: '(http.request.uri.path eq "/hook")', action_parameters: { ruleset: 'current' } })(r);
    events({ rules: [rl, { ruleId: 's1', rulesetId: 'rs-c', source: 'firewallCustom', action: 'skip', description: 'Skip partner', count: 1000 }],
      uas: [{ ruleId: 's1', source: 'firewallCustom', action: 'skip', ua: CHROME_UA, count: 1000 }],
      attacks: [{ ruleId: 's1', source: 'firewallCustom', action: 'skip', score: 9, count: 60 }, { ruleId: 's1', source: 'firewallCustom', action: 'skip', score: 90, count: 940 }] })(r);
  });
  fails('traffic.passthrough', s, 'confirmed', 'high');
  const rec = rowOf(s, 's1').passthrough!.recommendation;
  assert.equal(rec.action, 'narrow');
  assert.equal(rec.expression, '((http.request.uri.path eq "/hook")) and not (cf.waf.score lt 21)');
});
test('traffic.passthrough: Bot Management scores (Enterprise) vs heuristics', () => {
  const bm = snap((r) => {
    logRule(400, CHROME_UA, { asn: '64500', name: 'Example Broadband' })(r);
    (r.events as EventData).bots = [{ ruleId: 'c1', source: 'firewallCustom', action: 'log', score: 1, verified: '', count: 200 }, { ruleId: 'c1', source: 'firewallCustom', action: 'log', score: 1, verified: 'Search Engine Crawler', count: 50 }, { ruleId: 'c1', source: 'firewallCustom', action: 'log', score: 80, count: 150, verified: '' }];
  }, 'enterprise');
  fails('traffic.passthrough', bm, 'confirmed', 'medium');
  const p = rowOf(bm, 'c1').passthrough!;
  assert.equal(p.botBasis, 'score');
  assert.equal(p.bots, 200, 'verified bots are left out');
});
test('traffic.passthrough: an IP Access allow rule → replace it; threat paths count as malicious', () => {
  const s = snap((r) => {
    r.access_rules = [{ id: 'ar1', mode: 'whitelist', notes: 'Office', configuration: { target: 'ip', value: '203.0.113.5' } }];
    events({ rules: [rl, { ruleId: 'ar1', rulesetId: '', source: 'ip', action: 'allow', description: '', count: 300 }],
      paths: [{ ruleId: 'ar1', source: 'ip', action: 'allow', host: 'example.test', path: '/wp-login.php', count: 40 }, { ruleId: 'ar1', source: 'ip', action: 'allow', host: 'example.test', path: '/', count: 260 }],
      uas: [{ ruleId: 'ar1', source: 'ip', action: 'allow', ua: CHROME_UA, count: 300 }] })(r);
  });
  const f = fails('traffic.passthrough', s, 'needs_validation', 'high');
  assert.match(f[0].title, /IP Access rule “IP Access: Office”/);
  const rec = rowOf(s, 'ar1').passthrough!.recommendation;
  assert.equal(rec.action, 'replace_allow');
  assert.match(rec.expression ?? '', /\/wp-login\.php/);
});
test('traffic.passthrough: at most 25 rules are analysed, the rest are listed', () => {
  const s = snap(events({ rules: [rl, ...Array.from({ length: 30 }, (_, i) => ({ ruleId: `l${i}`, rulesetId: 'rs-c', source: 'firewallCustom', action: 'log', description: `Log ${i}`, count: 100 + i }))] }));
  const e = buildReport(s, { accountId: 'a1', accountName: 'Test', startedAt: NOW, finishedAt: NOW, calls: 0, lookups: 0 }).effectiveness!;
  assert.equal(e.recommendations.length, 25);
  assert.equal(e.notAnalysed.length, 5);
  assert.deepEqual(e.notAnalysed.map((x) => x.passed).sort(), [100, 101, 102, 103, 104]);
});

// ── Managed rulesets: overview, effectiveness, OWASP, exceptions' traffic, report layout ──
const report = (s: Snapshot) => buildReport(s, { accountId: 'a1', accountName: 'Test', startedAt: NOW, finishedAt: NOW, calls: 0, lookups: 0 });
test('managed overview: state, overrides, OWASP tuning and exceptions with their traffic', () => {
  const s = snap((r) => {
    managed(
      { id: 'x1', description: 'Upload exception', action: 'skip', expression: '(http.request.uri.path eq "/upload")', action_parameters: { rules: { [CF_MANAGED]: ['r1', 'r2'] } } },
      cfDep({ overrides: { categories: [{ category: 'wordpress', enabled: false }], rules: [{ id: 'r9', action: 'log' }] } }),
      owDep({ overrides: { categories: [{ category: 'paranoia-level-3', enabled: false }, { category: 'paranoia-level-4', enabled: false }], rules: [{ id: ANOMALY, score_threshold: 60 }] } }),
    )(r);
    events({ rules: [rl, { ruleId: 'x1', rulesetId: 'zrs-managed', source: 'firewallManaged', action: 'skip', description: 'Upload exception', count: 250 },
      { ruleId: 'r9', rulesetId: CF_MANAGED, source: 'firewallManaged', action: 'log', description: 'XSS probe', count: 30 }, { ruleId: ANOMALY, rulesetId: OWASP, source: 'firewallManaged', action: 'block', description: '949110', count: 12 }],
      uas: [{ ruleId: 'x1', source: 'firewallManaged', action: 'skip', ua: CHROME_UA, count: 250 }] })(r);
  });
  const m = report(s).managed!;
  const cf = m.rulesets.find((x) => x.id === CF_MANAGED)!, ow = m.rulesets.find((x) => x.id === OWASP)!;
  assert.equal(cf.state, 'deployed');
  assert.deepEqual(cf.overrides.map((o) => `${o.kind} ${o.id} ${o.change}`), ['category wordpress disabled', 'rule r9 action log']);
  assert.equal(cf.events!.topRules[0].logOnly, true);
  assert.equal(ow.paranoia, 2);
  assert.equal(ow.threshold, 60);
  assert.equal(m.rulesets.find((x) => x.id === FREE)!.state, 'not_deployed');
  assert.equal(m.rulesets.find((x) => x.id === SDD)!.state, 'not_applicable', 'Enterprise only');
  assert.equal(m.rulesets.find((x) => x.id === DDOS_L7)!.state, 'deployed', 'always on');
  assert.deepEqual(m.exceptions.map((x) => [x.name, x.skips, x.position, x.skipped, x.verdict]), [['Upload exception', '2 managed rules', 'before', 250, 'clean']]);
  assert.ok(m.exceptions[0].effectKey);
  assert.equal(m.leakedCredentials, 'on');
});
test('managed.exceptions evidence carries the traffic each exception skipped', () => {
  const s = snap((r) => {
    managed({ id: 'x1', description: 'All', action: 'skip', expression: 'true', action_parameters: { ruleset: 'current' } }, cfDep(), owDep())(r);
    events({ rules: [rl, { ruleId: 'x1', rulesetId: 'zrs-managed', source: 'firewallManaged', action: 'skip', description: 'All', count: 500 }] })(r);
  });
  const f = fails('managed.exceptions', s, 'confirmed', 'high');
  assert.ok(f[0].evidence.some((e) => /skipped/.test(e.field) && e.value.startsWith('500')), JSON.stringify(f[0].evidence));
});
test('traffic.managed_effect: zero matches (info) and rules matching only in log', () => {
  fails('traffic.managed_effect', snap(events({ rules: [rl, { ruleId: ANOMALY, rulesetId: OWASP, source: 'firewallManaged', action: 'block', description: '949110', count: 15 }] })), 'confirmed', 'info');
  const f = fails('traffic.managed_effect', snap(events({ rules: [rl, { ruleId: ANOMALY, rulesetId: OWASP, source: 'firewallManaged', action: 'block', description: '949110', count: 15 },
    { ruleId: 'r9', rulesetId: CF_MANAGED, source: 'firewallManaged', action: 'log', description: 'XSS probe', count: 30 }] })), 'confirmed', 'low');
  assert.match(f[0].description, /r9 \(XSS probe\): 30/);
});
test('traffic.owasp_effect: flagged but never blocked; likely false positives on the blocked slice', () => {
  const owaspEvents = (action: string, count: number, extra: Partial<EventData> = {}) => events({ rules: [rl, { ruleId: 'm1', rulesetId: CF_MANAGED, source: 'firewallManaged', action: 'block', description: 'SQLi', count: 20 }, { ruleId: ANOMALY, rulesetId: OWASP, source: 'firewallManaged', action, description: '949110', count }], ...extra });
  fails('traffic.owasp_effect', snap(owaspEvents('log', 300)), 'confirmed', 'medium');
  const ips = Array.from({ length: 60 }, (_, i) => ({ ruleId: ANOMALY, source: 'firewallManaged', action: 'block', ip: `198.51.100.${i + 1}`, count: 5 }));
  const asns = Array.from({ length: 10 }, (_, i) => ({ ruleId: ANOMALY, source: 'firewallManaged', action: 'block', asn: String(64500 + i), name: `Example Broadband ${i}`, count: 30 }));
  const f = fails('traffic.owasp_effect', snap(owaspEvents('block', 300, { ips, asns, uas: [{ ruleId: ANOMALY, source: 'firewallManaged', action: 'block', ua: CHROME_UA, count: 300 }],
    paths: [{ ruleId: ANOMALY, source: 'firewallManaged', action: 'block', host: 'example.test', path: '/checkout', count: 300 }] })), 'needs_validation', 'medium');
  assert.ok(f[0].fix.some((x) => x.includes('from 40 to 60')), f[0].fix.join(' | '));
  assert.ok(f[0].fix.some((x) => x.includes('http.request.uri.path eq "/checkout"')));
  assert.equal(state('traffic.owasp_effect', snap(managed(cfDep()))), 'not_applicable');
});
test('recommended actions: traffic recommendations and fixes of confirmed high findings, most important first', () => {
  const r = report(snap((x) => { setting('ssl', 'flexible')(x); logRule(400, PY)(x); }));
  const items = actionItems(r);
  assert.ok(items.some((i) => i.source === 'finding' && i.fingerprint === 'zone:z1:tls.ssl_mode'));
  assert.ok(items.some((i) => i.source === 'traffic' && i.action === 'block_or_challenge'));
  assert.equal(items[0].severity, 'high');
  assert.ok(!items.some((i) => i.action === 'keep' || i.action === 'no_conclusion'));
});
test('REPORT.md follows the page order', () => {
  const md = auditMarkdown(report(snap()), 'Castellan');
  const at = (h: string) => md.indexOf(h);
  const order = ['## Summary', '## Findings', '## Recommended actions', '## Effectiveness', '## Managed ruleset', '## Coverage ledger', '## Method'].map(at);
  assert.ok(order.every((x, i) => x > 0 && (!i || x > order[i - 1])), JSON.stringify(order));
  assert.ok(auditCsv(report(snap()), 'managed').startsWith('ruleset,id,state'));
});
