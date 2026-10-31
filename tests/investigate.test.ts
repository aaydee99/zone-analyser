import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRay, rayWindow } from '@/lib/ray-parse';
import { fillBuckets, findSpikes, median, thresholdOf } from '@/lib/timeline-spikes';
import { commonPrefix, draftException, isBrowserUa, isChallenge, isHostingAsn, isSolved, normAction, ruleString, scoreRule, type RuleStats } from '@/lib/waf-fp-score';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

test('parseRay takes the 16 hex characters, with or without the data center', () => {
  assert.equal(parseRay('8F3A1B2C4D5E6F70-AMS'), '8f3a1b2c4d5e6f70');
  assert.equal(parseRay(' 8f3a1b2c4d5e6f70 '), '8f3a1b2c4d5e6f70');
  assert.equal(parseRay('8f3a1b2c4d5e6f7'), null);
  assert.equal(parseRay('8f3a1b2c4d5e6f70"}'), null, 'nothing that could leave a GraphQL string');
  assert.equal(parseRay('zzzzzzzzzzzzzzzz'), null);
});

test('rayWindow cuts the window into days, newest first, and never older than 31 days', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const w = rayWindow(72, undefined, now);
  assert.equal(w.slices.length, 3);
  assert.equal(w.slices[0].until, '2026-10-31T12:00:00.000Z');
  assert.equal(w.slices.at(-1)!.since, '2026-10-28T12:00:00.000Z');
  const around = rayWindow(6, '2026-10-30T12:00:00Z', now);
  assert.equal(around.since, '2026-10-30T09:00:00.000Z');
  assert.equal(around.until, '2026-10-30T15:00:00.000Z');
  // Centred on a time just before now: the window ends now.
  assert.equal(rayWindow(6, '2026-10-31T11:00:00Z', now).until, '2026-10-31T12:00:00.000Z');
  assert.throws(() => rayWindow(24, '2026-08-01T00:00:00Z', now), /31 days/);
  assert.throws(() => rayWindow(24, 'yesterday', now), /Not a time/);
});

test('actions are compared in every spelling Cloudflare uses', () => {
  assert.equal(normAction('managed_challenge'), 'managedchallenge');
  assert.ok(isChallenge('managedChallenge') && isChallenge('jschallenge'));
  assert.ok(isSolved('managed_challenge_interactive_solved') && isSolved('challengeSolved') && isSolved('jschallengebypassed'));
  assert.ok(!isSolved('block'));
});

test('browsers and hosting networks are told apart', () => {
  assert.ok(isBrowserUa(CHROME));
  assert.ok(!isBrowserUa('curl/8.4.0'));
  assert.ok(!isBrowserUa('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/130.0 Safari/537.36'));
  assert.ok(isHostingAsn('AMAZON-02'));
  assert.ok(isHostingAsn('DIGITALOCEAN-ASN'));
  assert.ok(!isHostingAsn('Example Broadband Ltd'));
  assert.ok(!isHostingAsn('COLOMBIA TELECOMUNICACIONES'), 'not mistaken for a colocation network');
});

/** A rule's events: `ips` clients with `per` events each, from consumer networks on browsers, on one path. */
function legit(ips: number, per: number, extra: Partial<RuleStats> = {}): RuleStats {
  const list = Array.from({ length: ips }, (_, i) => ({ ip: `198.51.100.${i % 250}`, count: per }));
  const n = ips * per;
  return {
    ruleId: 'r1', rulesetId: 'efb7b8c949ac4650a09736fc376e9aee', source: 'firewallManaged', description: 'Example rule',
    actions: { managed_challenge: n, managed_challenge_interactive_solved: Math.round(n * 0.7) },
    ips: list, asns: Array.from({ length: 12 }, (_, i) => ({ asn: String(64500 + i), name: `Example Broadband ${i}`, count: Math.round(n / 12) })),
    paths: [{ host: 'www.example.com', path: '/checkout', count: n }], uas: [{ ua: CHROME, count: n }], ...extra,
  };
}

test('scoreRule ranks legitimate-looking traffic high, and says why', () => {
  const s = scoreRule(legit(80, 3), 0.97);
  assert.ok(s.score >= 80, `score ${s.score}`);
  assert.equal(s.challenged, 240);
  assert.equal(s.solved, 168);
  for (const k of ['ips', 'spread', 'asns', 'residential', 'browsers', 'ok-path', 'solved', 'one-path']) assert.ok(s.signals.some((x) => x.key === k), `signal ${k}`);
  for (const x of s.signals) assert.ok(x.detail.length > 0);
});

test('scoreRule ranks one scanner from a hosting network low', () => {
  const s = scoreRule({
    ruleId: 'r2', rulesetId: '', source: 'firewallCustom', description: 'Block scanners', actions: { block: 500 },
    ips: [{ ip: '203.0.113.9', count: 480 }, { ip: '203.0.113.10', count: 20 }], asns: [{ asn: '64496', name: 'EXAMPLE-HOSTING-AS', count: 500 }],
    paths: [{ host: 'www.example.com', path: '/wp-login.php', count: 500 }], uas: [{ ua: 'python-requests/2.31', count: 500 }],
  }, null);
  assert.equal(s.score, 0, `the minus points outweigh "one rule, one path": ${JSON.stringify(s.signals)}`);
  assert.ok(s.signals.some((x) => x.key === 'one-client' && x.points < 0));
  assert.equal(s.blocked, 500);
});

test('draftException skips one managed rule for one path', () => {
  const d = draftException({ ruleId: 'r1', rulesetId: 'efb7b8c949ac4650a09736fc376e9aee', source: 'firewallManaged', description: 'x', rulesetName: 'Cloudflare Managed Ruleset', host: 'www.example.com', path: '/checkout', pathShare: 0.9 }, ['/checkout']);
  assert.equal(d.phase, 'http_request_firewall_managed');
  assert.equal(d.action, 'skip');
  assert.deepEqual(d.actionParameters, { rules: { efb7b8c949ac4650a09736fc376e9aee: ['r1'] } });
  assert.equal(d.expression, '(http.host eq "www.example.com" and http.request.uri.path eq "/checkout")');
});

test('draftException uses a path prefix when the paths are spread, and edits custom rules instead of skipping', () => {
  const d = draftException({ ruleId: 'c1', rulesetId: 'x', source: 'firewallCustom', description: 'Geo block', host: 'api.example.com', path: '/v2/a', pathShare: 0.3 }, ['/v2/a', '/v2/b', '/v2/c']);
  assert.match(d.expression, /starts_with\(http\.request\.uri\.path, "\/v2\/"\)/);
  assert.notEqual(d.action, 'skip');
  assert.deepEqual(draftException({ ruleId: '', rulesetId: '', source: 'botFight', description: '', host: 'a.example.com', path: '/', pathShare: 1 }, ['/']).actionParameters, { phases: ['http_request_sbfm'] });
  assert.deepEqual(draftException({ ruleId: '', rulesetId: '', source: 'securitylevel', description: '', host: 'a.example.com', path: '/', pathShare: 1 }, ['/']).actionParameters, { products: ['securityLevel'] });
});

test('ruleString escapes quotes and backslashes; commonPrefix keeps whole segments', () => {
  assert.equal(ruleString('/a"b\\c'), '"/a\\"b\\\\c"');
  assert.equal(commonPrefix(['/api/v2/users', '/api/v2/orders']), '/api/v2/');
  assert.equal(commonPrefix(['/apix', '/apiy']), '/');
});

test('fillBuckets adds the empty buckets Cloudflare leaves out', () => {
  const p = fillBuckets([{ t: '2026-10-31T01:00:00Z', v: 5 }, { t: '2026-10-31T01:02:00Z', v: 1 }], '2026-10-31T00:00:00Z', '2026-10-31T03:00:00Z', 3_600_000);
  assert.deepEqual(p.map((x) => x.v), [0, 6, 0]);
});

test('findSpikes flags a burst well above the median and merges neighbours', () => {
  const v = [10, 12, 9, 11, 10, 300, 250, 10, 11, 9, 12, 10];
  const series = v.map((x, i) => ({ t: new Date(Date.UTC(2026, 9, 31, i)).toISOString(), v: x }));
  const s = findSpikes(series, 20);
  assert.equal(s.length, 1);
  assert.equal(s[0].peak, 300);
  assert.equal(s[0].total, 550);
  assert.equal(s[0].start, '2026-10-31T05:00:00.000Z');
  assert.equal(s[0].end, '2026-10-31T06:00:00.000Z');
  assert.equal(median([3, 1, 2]), 2);
  assert.ok(thresholdOf([0, 0, 0], 20).threshold === 20, 'a quiet series needs the minimum');
  assert.equal(findSpikes(series.map((x) => ({ ...x, v: 15 })), 20).length, 0, 'steady traffic has no spike');
});
