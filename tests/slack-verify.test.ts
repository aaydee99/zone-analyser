import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSlackResponseUrl, parseSlashCommand, signSlack, verifySlack } from '@/lib/slack-verify';

const SECRET = 'test-signing-secret-not-real';
const body = 'command=%2Fcastellan&text=zone+example.com&user_id=U012ABCDEF&team_id=T012ABC&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT012%2F1%2Fabc';

test('a request signed with the secret within five minutes is accepted', () => {
  const now = 1_800_000_000;
  const ts = String(now - 30);
  assert.deepEqual(verifySlack(SECRET, ts, signSlack(SECRET, ts, body), body, now), { ok: true });
});

test('wrong secret, changed body, old or future timestamps and missing headers are refused', () => {
  const now = 1_800_000_000;
  const ts = String(now);
  const sig = signSlack(SECRET, ts, body);
  assert.deepEqual(verifySlack('another-secret', ts, sig, body, now), { ok: false, why: 'mismatch' });
  assert.deepEqual(verifySlack(SECRET, ts, sig, `${body}&x=1`, now), { ok: false, why: 'mismatch' });
  assert.deepEqual(verifySlack(SECRET, ts, sig.slice(0, -1), body, now), { ok: false, why: 'mismatch' });
  const old = String(now - 301);
  assert.deepEqual(verifySlack(SECRET, old, signSlack(SECRET, old, body), body, now), { ok: false, why: 'stale' });
  const future = String(now + 301);
  assert.deepEqual(verifySlack(SECRET, future, signSlack(SECRET, future, body), body, now), { ok: false, why: 'stale' });
  assert.deepEqual(verifySlack(SECRET, 'abc', sig, body, now), { ok: false, why: 'stale' });
  assert.deepEqual(verifySlack(SECRET, null, sig, body, now), { ok: false, why: 'missing' });
  assert.deepEqual(verifySlack('', ts, sig, body, now), { ok: false, why: 'missing' });
});

test('a slash command is read from its form body', () => {
  const c = parseSlashCommand(body);
  assert.equal(c.command, '/castellan');
  assert.equal(c.text, 'zone example.com');
  assert.equal(c.userId, 'U012ABCDEF');
  assert.ok(isSlackResponseUrl(c.responseUrl));
});

test('answers go to Slack response addresses only', () => {
  for (const bad of ['http://hooks.slack.com/commands/x', 'https://hooks.slack.com.evil.example/commands/x', 'https://evil.example/commands/x',
    'https://hooks.slack.com/services/T/B/x', 'https://user:pw@hooks.slack.com/commands/x', 'https://hooks.slack.com:8443/commands/x', 'not a url']) {
    assert.equal(isSlackResponseUrl(bad), false, bad);
  }
  assert.ok(isSlackResponseUrl('https://hooks.slack.com/actions/T1/2/abc'));
});
