import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bandOf, botSummary } from '@/lib/bot-score';

test("a score falls in Cloudflare's band: 1 automated, 2–29 likely automated, 30–99 likely human, 0 not scored", () => {
  assert.equal(bandOf(1), 'automated');
  assert.equal(bandOf('2'), 'likely_automated');
  assert.equal(bandOf(29), 'likely_automated');
  assert.equal(bandOf(30), 'likely_human');
  assert.equal(bandOf('99'), 'likely_human');
  for (const x of [0, '0', '', null, undefined, 100, 'x']) assert.equal(bandOf(x), 'not_scored', String(x));
});

test('the summary counts each band exactly, with the average and median of the scored requests', () => {
  const row = (botScore: string, count: number) => ({ dims: { botScore }, count });
  const s = botSummary([row('1', 300), row('15', 100), row('45', 200), row('99', 380), row('0', 20)]);
  assert.equal(s.total, 1000);
  assert.equal(s.scored, 980);
  assert.deepEqual(Object.fromEntries(s.bands.map((b) => [b.key, b.count])), { automated: 300, likely_automated: 100, likely_human: 580, not_scored: 20 });
  // (1×300 + 15×100 + 45×200 + 99×380) / 980 = 48,420 / 980 = 49.4
  assert.equal(s.mean, 49.4);
  // The 490th of 980 scored requests (sorted by score) has score 45.
  assert.equal(s.median, 45);
  const r = Object.fromEntries(s.ranges.map((x) => [x.label, x.count]));
  assert.equal(r['1'], 300);
  assert.equal(r['10–19'], 100);
  assert.equal(r['40–49'], 200);
  assert.equal(r['90–99'], 380);
  assert.equal(s.ranges.reduce((n, x) => n + x.count, 0), s.scored, 'every scored request is in one range');
});

test('no scored requests: no average', () => {
  const s = botSummary([{ dims: { botScore: '0' }, count: 5 }]);
  assert.equal(s.mean, null);
  assert.equal(s.median, null);
  assert.equal(s.bands.find((b) => b.key === 'not_scored')!.count, 5);
});
