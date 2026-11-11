import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ItemDiff } from '@/lib/zone-index';
import { groupCounts, groupOf, sortDiffs, whatOf, zoneDiffCsv, zoneDiffHtml, type ZoneDiffReport } from '@/lib/zone-diff-groups';

const d = (item: string, kind: ItemDiff['kind'], status: ItemDiff['status'] = 'different', a = ['x'], b = ['y']): ItemDiff => ({ item, kind, path: item, a, b, status });

test('rules are grouped by phase the way the dashboard names them; the rest by kind', () => {
  assert.equal(groupOf(d('ruleset:http_request_origin:2:action_parameters.origin.host', 'rule')).label, 'Origin rules');
  assert.equal(groupOf(d('ruleset:http_request_cache_settings:1:action', 'rule')).label, 'Cache rules');
  assert.equal(groupOf(d('ruleset:http_config_settings:present', 'rule')).label, 'Configuration rules');
  assert.equal(groupOf(d('ruleset:http_request_dynamic_redirect:1:action_parameters.from_value.target_url.value', 'redirect')).label, 'Single redirects');
  assert.equal(groupOf(d('ruleset:http_response_headers_transform:1:action_parameters.headers.X-Frame-Options.value', 'header')).label, 'Response header transform rules');
  assert.equal(groupOf(d('ruleset:some_new_phase:1:action', 'rule')).label, 'Ruleset some_new_phase');
  assert.equal(groupOf(d('dns:A:www', 'dns')).label, 'DNS records');
  assert.equal(groupOf(d('setting:ssl', 'setting')).label, 'Settings');
});

test('what a difference is inside its group', () => {
  assert.equal(whatOf(d('ruleset:http_request_origin:2:action_parameters.origin.host', 'rule')), 'Rule 2 · action_parameters.origin.host');
  assert.equal(whatOf(d('ruleset:http_request_origin:present', 'rule')), 'The ruleset itself');
  assert.equal(whatOf({ item: 'dns:A:www', path: 'DNS A www.{zone}' }), 'DNS A www.{zone}');
});

test('sorted in group order, rule 2 before rule 10; counts per group', () => {
  const list = [
    d('ruleset:http_request_origin:10:action', 'rule'), d('setting:ssl', 'setting', 'only-a'), d('ruleset:http_request_cache_settings:1:action', 'rule', 'only-b'),
    d('ruleset:http_request_origin:2:action', 'rule'), d('dns:A:www', 'dns'), d('ruleset:http_request_firewall_custom:1:expression', 'rule'),
  ];
  assert.deepEqual(sortDiffs(list).map((x) => x.item), [
    'dns:A:www', 'setting:ssl', 'ruleset:http_request_firewall_custom:1:expression', 'ruleset:http_request_cache_settings:1:action',
    'ruleset:http_request_origin:2:action', 'ruleset:http_request_origin:10:action',
  ]);
  const g = groupCounts(list);
  assert.deepEqual(g.map((x) => [x.label, x.different, x.onlyA, x.onlyB, x.total]), [
    ['DNS records', 1, 0, 0, 1], ['Settings', 0, 1, 0, 1], ['Custom rules (WAF)', 1, 0, 0, 1], ['Cache rules', 0, 0, 1, 1], ['Origin rules', 2, 0, 0, 2],
  ]);
});

const report = (diffs: ItemDiff[]): ZoneDiffReport => ({
  a: { id: 'za', name: 'a.example.test' }, b: { id: 'zb', name: 'b.example.test' }, diffs, same: 7,
  counts: { different: diffs.filter((x) => x.status === 'different').length, onlyA: diffs.filter((x) => x.status === 'only-a').length, onlyB: diffs.filter((x) => x.status === 'only-b').length },
  groups: groupCounts(diffs), generatedAt: '2026-11-11T15:00:00.000Z',
});

test('CSV: every difference with its group, full values, formulas made inert', () => {
  const csv = zoneDiffCsv(report([d('ruleset:http_request_origin:1:expression', 'rule', 'different', ['=cmd()', 'second line'], ['http.host eq "x"']), d('setting:ssl', 'setting', 'only-a', ['full'], [])]));
  assert.ok(csv.startsWith('﻿Group,What,Item,Status,a.example.test,b.example.test\r\n'));
  assert.match(csv, /Origin rules,Rule 1 · expression,ruleset:http_request_origin:1:expression,Different,"'=cmd\(\)\nsecond line","http\.host eq ""x"""/);
  assert.match(csv, /Settings,setting:ssl,setting:ssl,Only in a\.example\.test,full,\r\n$/);
});

test('HTML: self-contained, escaped, a section per group, nothing cut', () => {
  const long = 'v'.repeat(5000);
  const html = zoneDiffHtml(report([d('ruleset:http_request_cache_settings:1:action', 'rule', 'different', ['<script>alert(1)</script>'], [long])]), { brand: 'Castellan', at: 'Nov 11, 2026, 10:00 AM ET' });
  assert.ok(!/<script>alert/.test(html) && /&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(html));
  assert.ok(!/<script|<link|src=/.test(html));
  assert.match(html, /<section id="phase:http_request_cache_settings">\s*<h2>Cache rules <small>1 difference<\/small>/);
  assert.ok(html.includes(long));
  assert.match(zoneDiffHtml(report([]), { brand: 'B', at: 'now' }), /No differences/);
});
