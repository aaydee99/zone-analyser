import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMON_PATHS, PathError, checkPath, fillPath, nextPagePath } from '@/lib/api-console-paths';

const A = 'a'.repeat(32), Z = 'f'.repeat(32);

test('fillPath fills the placeholders and refuses what is left', () => {
  assert.equal(fillPath('/zones/{zone_id}/dns_records', { zoneId: Z }), `/zones/${Z}/dns_records`);
  assert.equal(fillPath('/accounts/:account_id/workers/scripts', { accountId: A }), `/accounts/${A}/workers/scripts`);
  assert.throws(() => fillPath('/zones/{zone_id}', {}), /Choose a zone/);
  assert.throws(() => fillPath('/zones/{zone_id}/rulesets/{ruleset_id}', { zoneId: Z }), /\{ruleset_id\}/);
});

test('checkPath allows relative reads under the known roots', () => {
  assert.equal(checkPath('/zones?per_page=50'), '/zones?per_page=50');
  assert.equal(checkPath('zones'), '/zones');
  assert.equal(checkPath('/client/v4/accounts'), '/accounts');
  assert.equal(checkPath(`/zones/${Z}/dns_records?name=a.example.com&match=https://x`), `/zones/${Z}/dns_records?name=a.example.com&match=https://x`);
  for (const p of COMMON_PATHS) assert.doesNotThrow(() => checkPath(fillPath(p.path, { accountId: A, zoneId: Z })), p.path);
});

test('checkPath refuses absolute URLs, traversal and other roots', () => {
  for (const bad of [
    'https://evil.example/zones', '//evil.example/zones', 'http:/zones', '/zones/../user', '/zones/%2e%2e/user', '/zones/%2E%2E/accounts',
    '/zones//x', '/zones\\x', '/zones#frag', '/graphql', '/zones/x y', `/accounts/${A}/cfd_tunnel/abc/token`, '/accounts/x?y?z', '/zones/%zz', '',
  ]) assert.throws(() => checkPath(bad), PathError, bad);
  assert.throws(() => checkPath(`/zones/${'x'.repeat(1100)}`), /longer/);
});

test('nextPagePath follows page numbers and cursors', () => {
  assert.equal(nextPagePath('/zones?per_page=50', { page: 1, total_pages: 3 }), '/zones?per_page=50&page=2');
  assert.equal(nextPagePath('/zones?page=3', { page: 3, total_pages: 3 }), null);
  assert.equal(nextPagePath('/accounts/x/audit_logs', { cursor: 'abc', count: 10 }), '/accounts/x/audit_logs?cursor=abc');
  assert.equal(nextPagePath('/x', { cursors: { after: 'n1' } }), '/x?cursor=n1');
  assert.equal(nextPagePath('/x', null), null);
});
