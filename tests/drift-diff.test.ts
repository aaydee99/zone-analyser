import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeBaseline, diffSnapshots, dnsLines, mergeTrail, ruleSnaps, whoChanged, type ZoneSnapshot } from '@/lib/checks/drift-diff';

const snap = (over: Partial<ZoneSnapshot> = {}): ZoneSnapshot => ({
  takenAt: '2026-11-01T00:00:00.000Z', zoneName: 'example.com', accountId: 'a', accountName: 'Example', settings: {}, rulesets: {}, dns: [], dnsProxied: [], dnssec: '', ...over,
});

const RULE = { id: 'r1', description: 'Block bad bots', expression: '(cf.client.bot)', action: 'block', enabled: true, version: '3', last_updated: '2026-10-01' };

test('a setting object: each field that changed, not the whole JSON', () => {
  const a = snap({ settings: { security_header: JSON.stringify({ strict_transport_security: { enabled: true, max_age: 31536000, preload: true } }), ssl: 'full' } });
  const b = snap({ settings: { security_header: JSON.stringify({ strict_transport_security: { enabled: true, max_age: 0, preload: true } }), ssl: 'strict' } });
  const c = diffSnapshots(a, b);
  assert.deepEqual(c.map((x) => [x.item, x.before, x.after]), [
    ['security_header.strict_transport_security.max_age', '31536000', '0'],
    ['ssl', 'full', 'strict'],
  ]);
  assert.ok(c.every((x) => x.severity === 'medium'));
});

test('rules: which rule changed and which field', () => {
  const base = snap({ rulesets: { s: { name: 'Custom rules', phase: 'http_request_firewall_custom', version: '3', rules: ruleSnaps([RULE, { id: 'r2', description: 'Allow office', expression: 'ip.src eq 192.0.2.1', action: 'skip', action_parameters: { ruleset: 'current' } }]) } } });
  const now = snap({ rulesets: { s: { name: 'Custom rules', phase: 'http_request_firewall_custom', version: '4', rules: ruleSnaps([
    { id: 'r2', description: 'Allow office', expression: 'ip.src eq 192.0.2.9', action: 'skip', action_parameters: { ruleset: 'current', phases: ['http_ratelimit'] } },
    { ...RULE, enabled: false, action: 'managed_challenge', version: '4' },
    { id: 'r3', description: 'Geo block', expression: 'ip.src.country eq "XX"', action: 'block' },
  ]) } } });
  const c = diffSnapshots(base, now).map((x) => `${x.item} | ${x.before} | ${x.after}`);
  assert.deepEqual(c, [
    'Custom rules › Geo block | — | added: block when ip.src.country eq "XX"',
    'Custom rules › Allow office › expression | ip.src eq 192.0.2.1 | ip.src eq 192.0.2.9',
    'Custom rules › Allow office › action_parameters.phases | — | ["http_ratelimit"]',
    'Custom rules › Allow office › order | position 2 | position 1',
    'Custom rules › Block bad bots | on | off',
    'Custom rules › Block bad bots › action | block | managed_challenge',
    'Custom rules › Block bad bots › order | position 1 | position 2',
  ]);
});

test('rules: a removed rule, a ruleset saved again unchanged, and an old baseline without rules', () => {
  const r = ruleSnaps([RULE]);
  const removed = diffSnapshots(snap({ rulesets: { s: { name: 'Custom rules', phase: 'p', version: '1', rules: r } } }), snap({ rulesets: { s: { name: 'Custom rules', phase: 'p', version: '2', rules: [] } } }));
  assert.deepEqual(removed.map((x) => [x.item, x.before, x.after]), [['Custom rules › Block bad bots', 'block when (cf.client.bot)', 'removed']]);
  const same = diffSnapshots(snap({ rulesets: { s: { name: 'Custom rules', phase: 'p', version: '1', rules: r } } }), snap({ rulesets: { s: { name: 'Custom rules', phase: 'p', version: '2', rules: ruleSnaps([{ ...RULE, version: '9', last_updated: 'x' }]) } } }));
  assert.equal(same.length, 1);
  assert.match(same[0].after, /no rule changed/);
  assert.equal(same[0].severity, 'low');
  const old = diffSnapshots(snap({ rulesets: { s: { name: 'Custom rules', phase: 'p', version: '1' } } }), snap({ rulesets: { s: { name: 'Custom rules', phase: 'p', version: '2', rules: r } } }));
  assert.match(old[0].after, /^version 2 \(rule details are compared from the next accepted baseline\)$/);
});

test('rule parameters are masked before they are kept', () => {
  const [r] = ruleSnaps([{ id: 'x', action: 'rewrite', action_parameters: { headers: { 'x-api-key': { value: 'secret' } } } }], () => ({ masked: true }));
  assert.equal(r.params, '{"masked":true}');
});

test('DNS: a changed record is one change with what it was and is; proxy changes', () => {
  const before = dnsLines('www.example.com.\t300\tIN\tA\t192.0.2.1 ; cf_tags=cf-proxied:true\napi.example.com. 1 IN A 192.0.2.5 ; cf_tags=cf-proxied:true\nold.example.com. 300 IN TXT "x"\nexample.com. 3600 IN SOA ns. host. 1 2 3 4 5');
  const after = dnsLines('www.example.com. 120 IN A 198.51.100.7 ; cf_tags=cf-proxied:true\napi.example.com. 1 IN A 192.0.2.5 ; cf_tags=cf-proxied:false\nnew.example.com. 300 IN CNAME www.example.com.');
  assert.deepEqual(before.proxied, ['api.example.com. 1 IN A 192.0.2.5', 'www.example.com. 300 IN A 192.0.2.1']);
  const c = diffSnapshots(snap({ dns: before.lines, dnsProxied: before.proxied }), snap({ dns: after.lines, dnsProxied: after.proxied }));
  assert.deepEqual(c.map((x) => `${x.item} | ${x.before} | ${x.after} | ${x.severity}`).sort(), [
    'A api.example.com. › proxy | proxied | DNS only | medium',
    'A www.example.com. | 192.0.2.1 · TTL 300 · proxied | 198.51.100.7 · TTL 120 · proxied | low',
    'CNAME new.example.com. | — | added: www.example.com. · TTL 300 · DNS only | low',
    'TXT old.example.com. | "x" · TTL 300 · DNS only | removed | low',
  ]);
});

test('DNS without proxy status (an older baseline): no proxy changes, no "DNS only" claims', () => {
  const c = diffSnapshots(snap({ dns: ['a.example.com. 300 IN A 192.0.2.1'], dnsProxied: undefined }), snap({ dns: ['a.example.com. 300 IN A 192.0.2.2'], dnsProxied: [] }));
  assert.deepEqual(c.map((x) => [x.item, x.before, x.after]), [['A a.example.com.', '192.0.2.1 · TTL 300', '192.0.2.2 · TTL 300']]);
});

test('completeBaseline fills in only what is safe to take from a newer read', () => {
  const rules = ruleSnaps([RULE]);
  const base = snap({ dns: ['a.example.com. 300 IN A 192.0.2.1'], dnsProxied: undefined, rulesets: { same: { name: 'S', phase: 'p', version: '3' }, moved: { name: 'M', phase: 'q', version: '1' } } });
  const now = snap({ dns: ['a.example.com. 300 IN A 192.0.2.1', 'b.example.com. 300 IN A 192.0.2.2'], dnsProxied: ['a.example.com. 300 IN A 192.0.2.1', 'b.example.com. 300 IN A 192.0.2.2'], rulesets: { same: { name: 'S', phase: 'p', version: '3', rules }, moved: { name: 'M', phase: 'q', version: '2', rules } } });
  const f = completeBaseline(base, now)!;
  assert.deepEqual(f.dnsProxied, ['a.example.com. 300 IN A 192.0.2.1']);
  assert.deepEqual(f.rulesets.same.rules, rules);
  assert.equal(f.rulesets.moved.rules, undefined, 'a new version is a change, not the baseline');
  assert.equal(completeBaseline(f, now), null);
});

test('who changed it: the newest audit entry since the baseline for that setting, ruleset, record or DNSSEC', () => {
  const trail = [
    { time: '2026-11-01T09:00:00Z', who: 'old@example.com', method: 'PATCH', uri: '/client/v4/zones/z1/settings/ssl', target: '' },
    { time: '2026-11-02T09:00:00Z', who: 'alice@example.com', method: 'PATCH', uri: 'https://api.cloudflare.com/client/v4/zones/z1/settings/ssl?x=1', target: '' },
    { time: '2026-11-02T10:00:00Z', who: 'bob@example.com', method: 'PATCH', uri: '/client/v4/zones/z1/settings/min_tls_version', target: '' },
    { time: '2026-11-02T11:00:00Z', who: 'API token “deploy”', method: 'PUT', uri: '/client/v4/zones/z1/rulesets/phases/http_request_firewall_custom/entrypoint', target: '' },
    { time: '2026-11-02T12:00:00Z', who: 'carol@example.com', method: 'PATCH', uri: '/client/v4/zones/z1/dns_records/abc', target: 'www.example.com' },
    { time: '2026-11-02T12:30:00Z', who: 'dave@example.com', method: 'PATCH', uri: '/client/v4/zones/z1/dns_records/def', target: 'api.example.com' },
  ];
  const since = '2026-11-01T12:00:00Z';
  const c = diffSnapshots(
    snap({ settings: { ssl: 'full' }, rulesets: { s: { name: 'Custom', phase: 'http_request_firewall_custom', version: '1' } }, dns: ['www.example.com. 300 IN A 192.0.2.1'] }),
    snap({ settings: { ssl: 'strict' }, rulesets: { s: { name: 'Custom', phase: 'http_request_firewall_custom', version: '2' } }, dns: ['www.example.com. 300 IN A 192.0.2.2'] }),
  );
  assert.deepEqual(c.map((x) => [x.area, whoChanged(x, trail, since)?.who ?? null]), [['Setting', 'alice@example.com'], ['Rules', 'API token “deploy”'], ['DNS', 'carol@example.com']]);
  assert.equal(whoChanged(c[0], trail, '2026-11-03T00:00:00Z'), null, 'entries older than the baseline do not count');
});

test('the kept audit trail: newest first, no repeats, old entries dropped', () => {
  const e = (time: string, who = 'a') => ({ time, who, method: 'PATCH', uri: '/zones/z/settings/ssl', target: '' });
  const now = Date.parse('2026-11-02T00:00:00Z');
  const t = mergeTrail([e('2026-09-01T00:00:00Z'), e('2026-11-01T00:00:00Z')], [e('2026-11-01T00:00:00Z'), e('2026-11-01T05:00:00Z', 'b')], now);
  assert.deepEqual(t.map((x) => [x.time, x.who]), [['2026-11-01T05:00:00Z', 'b'], ['2026-11-01T00:00:00Z', 'a']]);
  assert.equal(mergeTrail([], Array.from({ length: 80 }, (_, i) => e(new Date(now - i * 60_000).toISOString())), now).length, 60);
});
