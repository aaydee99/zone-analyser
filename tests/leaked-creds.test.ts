import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LeakedConfig, LeakedTraffic } from '@/lib/investigate-types';
import { answeredOk, credentialFields, isChecked, isLeaked, leakedFindings, resultOf, stops } from '@/lib/leaked-creds-score';

const cfg = (o: Partial<LeakedConfig> = {}): LeakedConfig => ({ enabled: true, detections: [], rules: [], header: false, ...o });
const rule = (action: string, expression = 'cf.waf.credential_check.username_and_password_leaked', enabled = true) =>
  ({ phase: 'custom' as const, id: 'r1', description: 'Leaked', enabled, action, expression, fields: credentialFields(expression) });
const traffic = (o: Partial<LeakedTraffic> = {}): LeakedTraffic => ({
  field: 'leakedCredentialCheckResult', since: '2026-11-07T00:00:00Z', until: '2026-11-08T00:00:00Z',
  results: [{ result: '', count: 9000 }, { result: 'clean', count: 900 }, { result: 'username_and_password_leaked', count: 60 }, { result: 'password_leaked', count: 40 }],
  leaked: 100, byStatus: [], byAction: [], paths: [], ips: [], hours: [], ...o,
});
const keys = (c: LeakedConfig | null, t: LeakedTraffic | null) => leakedFindings(c, t).map((f) => f.key);

test('credential fields are found in a rule expression, once each', () => {
  assert.deepEqual(credentialFields('(cf.waf.credential_check.password_leaked and cf.waf.auth_detected) or cf.waf.credential_check.password_leaked'),
    ['cf.waf.credential_check.password_leaked', 'cf.waf.auth_detected']);
  assert.deepEqual(credentialFields('http.request.uri.path eq "/login"'), []);
});

test('result values: leaked, checked and their labels', () => {
  for (const v of ['username_and_password_leaked', 'PASSWORD_LEAKED', 'username leaked', 'username_password_similar']) assert.ok(isLeaked(v), v);
  for (const v of ['', 'clean', 'CLEAN', 'none']) assert.ok(!isLeaked(v), v);
  assert.ok(isChecked('clean') && !isChecked(''));
  assert.equal(resultOf('USERNAME_AND_PASSWORD_LEAKED').tone, 'bad');
  assert.equal(resultOf('something_new').label, 'something_new');
  assert.ok(stops('managed_challenge') && stops('block') && !stops('log') && !stops('none'));
  assert.ok(answeredOk(200) && answeredOk(302) && !answeredOk(401) && !answeredOk(0));
});

test('detection off is the first finding', () => {
  assert.equal(keys(cfg({ enabled: false }), traffic())[0], 'off');
});

test('detection on with no rule, or rules that only log, are flagged', () => {
  assert.ok(keys(cfg(), traffic()).includes('no_rule'));
  assert.ok(keys(cfg({ rules: [rule('managed_challenge', 'cf.waf.credential_check.password_leaked', false)] }), traffic()).includes('no_rule'));
  const k = keys(cfg({ rules: [rule('log')] }), traffic());
  assert.ok(k.includes('log_only') && !k.includes('no_rule'));
  assert.ok(!keys(cfg({ rules: [rule('managed_challenge')] }), traffic()).some((x) => x === 'no_rule' || x === 'log_only'));
});

test('leaked requests let through and answered 2xx/3xx are counted exactly', () => {
  const t = traffic({
    byAction: [{ result: 'username_and_password_leaked', action: 'managed_challenge', count: 60 }, { result: 'password_leaked', action: 'none', count: 40 }],
    byStatus: [{ result: 'password_leaked', status: 302, count: 25 }, { result: 'password_leaked', status: 401, count: 15 }, { result: 'username_and_password_leaked', status: 403, count: 60 }],
  });
  const f = leakedFindings(cfg({ rules: [rule('managed_challenge')] }), t);
  const through = f.find((x) => x.key === 'through')!;
  assert.equal(through.tone, 'bad');
  assert.match(through.title, /^40 leaked-credential requests reached the origin/);
  assert.match(through.detail, /100 requests carried leaked credentials \(10\.0% of the 1,000 checked\); 60 \(60\.0%\) were blocked or challenged/);
  const ok = f.find((x) => x.key === 'answered_ok')!;
  assert.match(ok.title, /^25 leaked-credential logins were answered 2xx\/3xx/);
  assert.equal(f[0].tone, 'bad');
});

test('everything stopped is good; no action in analytics still reports the count', () => {
  const all = traffic({ byAction: [{ result: 'password_leaked', action: 'block', count: 100 }] });
  assert.equal(leakedFindings(cfg({ rules: [rule('block')] }), all).find((x) => x.key === 'through')!.tone, 'ok');
  assert.ok(keys(cfg({ rules: [rule('block')] }), traffic({ byAction: null })).includes('leaked'));
});

test('one client sending a fifth or more of the leaked requests is credential stuffing', () => {
  const t = traffic({ ips: [{ ip: '192.0.2.10', asn: '64500', asnName: 'Example', country: 'XX', count: 30 }, { ip: '198.51.100.7', asn: '64501', asnName: 'Other', country: 'XX', count: 70 }].sort((a, b) => b.count - a.count) });
  assert.ok(keys(cfg({ rules: [rule('block')] }), t).includes('concentrated'));
  assert.ok(!keys(cfg({ rules: [rule('block')] }), traffic({ ips: [{ ip: '192.0.2.1', asn: '1', asnName: '', country: '', count: 5 }] })).includes('concentrated'));
});

test('nothing checked suggests a custom detection location; clean traffic is good', () => {
  assert.ok(keys(cfg({ rules: [rule('block')] }), traffic({ results: [{ result: '', count: 500 }], leaked: 0 })).includes('nothing_checked'));
  assert.ok(keys(cfg({ rules: [rule('block')] }), traffic({ results: [{ result: '', count: 500 }, { result: 'clean', count: 20 }], leaked: 0 })).includes('clean'));
});
