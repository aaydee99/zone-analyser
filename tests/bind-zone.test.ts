import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareZones, parseZone } from '@/lib/bind-zone';
import { expressionLists, rulesetRefs } from '@/lib/list-refs';

const FILE = [
  '$ORIGIN example.test.',
  '$TTL 1h',
  '@   IN SOA ns1.example.test. hostmaster.example.test. (',
  '        2026103101 ; serial',
  '        3600 600 604800 300 )',
  '@        IN NS    ns1.other.test.',
  '@   300  IN A     192.0.2.10',
  'www      IN CNAME example.test.',
  'mail     IN A     198.51.100.7',
  '@        IN MX 10 mail',
  '@        IN MX 20 alias',
  'alias    IN CNAME mail.example.test.',
  '         IN TXT   "v=spf1 include:_spf.example.test; -all"',
  'old      IN A     203.0.113.9',
  'other.example.net. IN A 192.0.2.99',
  '$INCLUDE more.zone',
  'bogus line here',
].join('\n');

const CF = [
  ';; Domain:     example.test.',
  'example.test.\t3600\tIN\tSOA\tada.ns.cloudflare.com. dns.cloudflare.com. 2 10000 2400 604800 3600',
  'example.test.\t1\tIN\tA\t192.0.2.10 ; cf_tags=cf-proxied:true',
  'www.example.test.\t1\tIN\tCNAME\texample.test. ; cf_tags=cf-proxied:true',
  'mail.example.test.\t600\tIN\tA\t198.51.100.7 ; cf_tags=cf-proxied:false',
  'example.test.\t1\tIN\tMX\t10 mail.example.test.',
  'alias.example.test.\t1\tIN\tCNAME\tmail.example.test.',
  'alias.example.test.\t1\tIN\tTXT\t"v=spf1 include:_spf.example.test; -all"',
  'new.example.test.\t1\tIN\tA\t192.0.2.50 ; cf_tags=cf-proxied:false',
].join('\n');

test('parseZone reads origins, TTLs, blank owners, parentheses, quotes and cf_tags', () => {
  const p = parseZone(FILE);
  assert.equal(p.origin, 'example.test');
  const soa = p.records.find((r) => r.type === 'SOA');
  assert.ok(soa && /2026103101 3600 600 604800 300$/.test(soa.content), String(soa?.content));
  assert.equal(p.records.find((r) => r.type === 'A' && r.name === 'example.test')?.ttl, 300);
  assert.equal(p.records.find((r) => r.name === 'mail.example.test')?.ttl, 3600, '$TTL 1h');
  assert.deepEqual(p.records.filter((r) => r.type === 'MX').map((r) => r.content), ['10 mail.example.test', '20 alias.example.test']);
  const txt = p.records.find((r) => r.type === 'TXT');
  assert.equal(txt?.name, 'alias.example.test', 'a blank owner repeats the last name');
  assert.equal(txt?.content, '"v=spf1 include:_spf.example.test; -all"', 'a ";" inside quotes is not a comment');
  assert.equal(p.errors.length, 2, JSON.stringify(p.errors));
  const cf = parseZone(CF, 'example.test');
  assert.equal(cf.records.find((r) => r.name === 'example.test' && r.type === 'A')?.proxied, true);
  assert.equal(cf.records.find((r) => r.name === 'mail.example.test')?.proxied, false);
});

test('compareZones: missing, extra, different, TTL, proxy and what breaks', () => {
  const d = compareZones(parseZone(FILE).records, parseZone(CF, 'example.test').records, 'example.test');
  const of = (k: string) => d.rows.filter((r) => r.kind === k).map((r) => `${r.name} ${r.type}`);
  assert.deepEqual(of('missing'), ['old.example.test A', 'other.example.net A']);
  assert.deepEqual(of('extra'), ['new.example.test A']);
  assert.deepEqual(of('different'), ['example.test MX']);
  assert.deepEqual(of('ttl'), ['mail.example.test A'], 'automatic TTL (1) is not a difference');
  assert.ok(of('breaks').includes('alias.example.test CNAME'), 'a CNAME next to a TXT');
  assert.ok(of('breaks').includes('example.test MX'), 'MX at a CNAME');
  assert.ok(of('breaks').includes('other.example.net A'), 'outside the zone');
  assert.ok(!d.rows.some((r) => r.type === 'SOA' || (r.type === 'NS' && r.name === 'example.test')), 'SOA and apex NS are not compared');
  const same = compareZones(parseZone(CF, 'example.test').records, parseZone(CF, 'example.test').records, 'example.test');
  assert.equal(same.rows.filter((r) => r.kind !== 'breaks').length, 0);
});

test('expressionLists and rulesetRefs', () => {
  assert.deepEqual(expressionLists('(ip.src in $office_ips and not ip.src in $cf.malware) or http.host eq "$not_a_list"'), ['office_ips', 'cf.malware']);
  assert.deepEqual(expressionLists(''), []);
  const refs = rulesetRefs({ id: 'rs1', name: 'Custom', phase: 'http_request_firewall_custom', rules: [
    { id: 'r1', description: 'Block bad', expression: 'ip.src in $bad_ips', action: 'block' },
    { id: 'r2', expression: 'ip.geoip.asnum in $asns', action: 'managed_challenge', enabled: false },
    { id: 'r3', expression: 'http.request.full_uri in $redirects', action: 'redirect', action_parameters: { from_list: { name: 'redirects' } } },
  ] }, new Set(['bad_ips', 'asns', 'redirects']));
  assert.deepEqual(refs.map((r) => [r.list, r.rule, r.enabled]), [['bad_ips', 'Block bad', true], ['asns', 'r2', false], ['redirects', 'r3', true]]);
});
