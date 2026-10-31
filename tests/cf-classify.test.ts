import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, diff, fields, redact, resourceKey, stateAfter, targetName, unwrap, type ClassifyInput } from '@/lib/cf-classify';

const entry = (over: Partial<ClassifyInput>): ClassifyInput => ({ method: 'PATCH', uri: '', product: '', resourceType: '', actionType: 'update', description: '', ...over });

test('classify: zones themselves are onboarding', () => {
  assert.deepEqual(classify(entry({ method: 'POST', uri: '/client/v4/zones' })), { category: 'onboarding', feature: 'Zone added' });
  assert.deepEqual(classify(entry({ method: 'DELETE', uri: '/zones/abc' })), { category: 'onboarding', feature: 'Zone removed' });
});

test('classify: ruleset phases map to their product', () => {
  assert.deepEqual(classify(entry({ uri: '/zones/abc/rulesets/phases/http_request_firewall_custom/entrypoint' })), { category: 'security', feature: 'WAF custom rules' });
  // The phase can also come from the ruleset itself.
  assert.equal(classify(entry({ uri: '/zones/abc/rulesets/r1', state: { phase: 'http_request_firewall_managed' } })).category, 'security');
});

test('classify: settings and unknowns', () => {
  assert.equal(classify(entry({ uri: '/zones/abc/settings/some_new_setting?x=1' })).feature, 'Setting: Some new setting');
  assert.equal(classify(entry({ uri: '/zones/abc/dns_records/1' })).category, 'dns');
  assert.deepEqual(classify(entry({ uri: '/nothing/known' })), { category: 'other', feature: 'Other' });
});

test('redact hides secret-looking keys at any depth', () => {
  assert.deepEqual(
    redact({ name: 'x', api_key: 'k', nested: [{ client_secret: 's', ok: 1 }] }),
    { name: 'x', api_key: '••••••••', nested: [{ client_secret: '••••••••', ok: 1 }] },
  );
});

test('unwrap and stateAfter', () => {
  assert.deepEqual(unwrap('{"success":true,"errors":[],"result":{"id":"1"}}'), { id: '1' });
  assert.equal(unwrap('not json'), 'not json');
  assert.equal(stateAfter('delete', { a: 1 }, { a: 2 }), null);
  assert.deepEqual(stateAfter('update', { a: 1 }, { success: true, result: {} }), { a: 1 });
  assert.equal(stateAfter('update', {}, null), undefined);
});

test('diff reports changed fields, skips noise and matches array items by id', () => {
  const before = { value: 'off', modified_on: '1', rules: [{ id: 'r1', description: 'block', action: 'block' }, { id: 'r2', description: 'gone' }] };
  const after = { value: 'on', modified_on: '2', rules: [{ id: 'r1', description: 'block', action: 'challenge' }, { id: 'r3', description: 'new' }] };
  assert.deepEqual(diff(before, after), [
    { path: 'rules[block].action', old: 'block', new: 'challenge' },
    { path: 'rules[new]', new: '{"id":"r3","description":"new"}' },
    { path: 'rules[gone]', old: '{"id":"r2","description":"gone"}' },
    { path: 'value', old: 'off', new: 'on' },
  ]);
  assert.deepEqual(diff(1, 1), []);
});

test('fields, targetName, resourceKey', () => {
  assert.deepEqual(fields({ id: '1', name: 'n', empty: '' }, 'new'), [{ path: 'name', new: 'n' }]);
  assert.deepEqual(fields(null, 'old'), []);
  assert.equal(targetName({ type: 'A', name: 'www.example.com', content: '192.0.2.1' }, 'f'), 'A www.example.com');
  assert.equal(targetName({ phase: 'p', rules: [] }, 'f'), '');
  assert.equal(targetName(null, 'fallback'), 'fallback');
  const base = { accountId: 'a', zoneId: 'z', product: 'p', resourceType: 't', resourceId: '', uri: '/client/v4/zones/z/x?y', method: 'PATCH' };
  assert.equal(resourceKey(base), 'a|/zones/z/x');
  assert.equal(resourceKey({ ...base, method: 'POST' }), '');
  assert.equal(resourceKey({ ...base, resourceId: 'r' }), 'a|z|p|t|r');
});
