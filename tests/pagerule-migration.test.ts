import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchExpression, moveOf, planPageRule, redirectOf, ttl } from '@/lib/pagerule-migration';

// Examples from developers.cloudflare.com/rules/reference/page-rules-migration.

test('a URL pattern becomes a filter expression (scheme and query string matched as Page Rules did)', () => {
  assert.equal(matchExpression('example.com/*/downloads/*.txt'), 'http.request.full_uri wildcard "http*://example.com/*/downloads/*.txt*"');
  assert.equal(matchExpression('https://example.com/blog/*'), 'http.request.full_uri wildcard "https://example.com/blog/*"');
  assert.equal(matchExpression('example.com/a"b'), 'http.request.full_uri wildcard "http*://example.com/a\\"b*"');
});

test('a Forwarding URL becomes a Single Redirect, its $n moved on for http*://', () => {
  assert.deepEqual(redirectOf('www.example.com/*', { url: 'https://example.com/$1', status_code: 301 }), { request: 'http*://www.example.com/*', target: 'https://example.com/${2}', status: 301 });
  assert.deepEqual(redirectOf('https://example.com/old-path/*', { url: 'https://example.com/new-path/$1', status_code: 302 }), { request: 'https://example.com/old-path/*', target: 'https://example.com/new-path/${1}', status: 302 });
});

test('each setting: the rule type and the exact field and value', () => {
  assert.deepEqual(moveOf('edge_cache_ttl', 86400), { product: 'Cache rule', set: 'Cache eligibility: Eligible for cache · Edge TTL: Ignore cache-control header and use this TTL · 1 day' });
  assert.equal(moveOf('browser_cache_ttl', 7200).set, 'Cache eligibility: Eligible for cache · Browser TTL: Override origin and use this TTL · 2 hours');
  assert.equal(moveOf('cache_level', 'cache_everything').set, 'Cache eligibility: Eligible for cache (caches everything, as Cache Everything did)');
  assert.equal(moveOf('cache_level', 'bypass').set, 'Cache eligibility: Bypass cache');
  assert.deepEqual(moveOf('security_level', 'under_attack'), { product: 'Configuration rule', set: 'I’m Under Attack: On' });
  assert.equal(moveOf('ssl', 'strict').set, 'SSL: Strict');
  assert.equal(moveOf('host_header_override', 'origin.example.net').set, 'Host Header › Rewrite to: origin.example.net');
  assert.equal(moveOf('resolve_override', 'lb.example.net').product, 'Origin rule');
  assert.equal(moveOf('true_client_ip_header', 'on').product, 'Managed Transform');
  assert.match(moveOf('cache_ttl_by_status', { '200-299': 86400, 404: 'no-cache' }).set, /Status code TTL: 404: no-cache, 200-299: 1 day$/);
  for (const id of ['disable_railgun', 'response_buffering', 'waf']) assert.equal(moveOf(id, 'on').none, true, id);
  assert.deepEqual([moveOf('disable_security', undefined).product, moveOf('disable_security', undefined).none], ['Configuration rule', true]);
  assert.equal(moveOf('something_new', 1).none, true);
  assert.equal(ttl(90), '90 seconds');
});

test('a Page Rule becomes one rule per rule type, with the same match', () => {
  const p = planPageRule({ id: 'p', priority: 2, targets: [{ constraint: { value: 'example.com/static/*' } }], actions: [
    { id: 'cache_level', value: 'cache_everything' }, { id: 'edge_cache_ttl', value: 3600 }, { id: 'ssl', value: 'full' }, { id: 'rocket_loader', value: 'off' },
  ] });
  assert.equal(p.verdict, 'Yes');
  assert.deepEqual(p.rules.map((r) => [r.product, r.match, r.set.length]), [
    ['Cache rule', 'http.request.full_uri wildcard "http*://example.com/static/*"', 2],
    ['Configuration rule', 'http.request.full_uri wildcard "http*://example.com/static/*"', 2],
  ]);
  assert.match(p.rules[0].where, /http_request_cache_settings/);
  const q = planPageRule({ id: 'q', targets: [{ constraint: { value: '*example.com/*' } }], actions: [{ id: 'waf', value: 'off' }] });
  assert.deepEqual([q.verdict, q.rules.length, q.manual[0].setting], ['No', 0, 'waf']);
  const r = planPageRule({ id: 'r', targets: [{ constraint: { value: 'example.com/x' } }], actions: [{ id: 'disable_performance' }] });
  assert.equal(r.verdict, 'Partly');
  assert.match(r.rules[0].set[0], /Polish: Off · Rocket Loader: Off/);
});
