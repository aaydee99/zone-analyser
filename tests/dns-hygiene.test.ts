import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareDelegation, compareDnssec, dsKeyTags, inZone, isPrivateIp, originLeaks, takeoverService } from '@/lib/dns-hygiene';
import { explain } from '@/lib/zone-health-types';

test('takeoverService knows the prone providers and their mode', () => {
  assert.deepEqual(takeoverService('shop-old.azurewebsites.net.'), { service: 'Azure App Service', mode: 'nxdomain' });
  assert.equal(takeoverService('docs.github.io')?.service, 'GitHub Pages');
  assert.equal(takeoverService('bucket.s3-website-us-east-1.amazonaws.com')?.service, 'AWS S3 website');
  assert.equal(takeoverService('bucket.s3-website.eu-west-1.amazonaws.com')?.mode, 'http');
  assert.equal(takeoverService('d111111abcdef8.cloudfront.net')?.service, 'AWS CloudFront');
  assert.equal(takeoverService('app.example.test'), null);
  assert.equal(takeoverService('notazurewebsites.net'), null, 'a suffix must match at a label boundary');
});

test('inZone and isPrivateIp', () => {
  assert.ok(inZone('www.example.com', 'example.com.'));
  assert.ok(inZone('EXAMPLE.com', 'example.com'));
  assert.ok(!inZone('badexample.com', 'example.com'));
  assert.ok(isPrivateIp('10.1.2.3') && isPrivateIp('192.168.0.1') && isPrivateIp('172.20.0.1') && isPrivateIp('fd00::1'));
  assert.ok(!isPrivateIp('192.0.2.10') && !isPrivateIp('203.0.113.5') && !isPrivateIp('2001:db8::1'));
});

test('originLeaks finds unproxied records that give proxied ones away', () => {
  const leaks = originLeaks([
    { name: 'www.example.test', type: 'A', content: '192.0.2.10', proxied: true },
    { name: 'www.example.test', type: 'AAAA', content: '2001:db8::10', proxied: false },
    { name: 'direct.example.test', type: 'A', content: '192.0.2.10', proxied: false },
    { name: 'mail.example.test', type: 'A', content: '198.51.100.7', proxied: false },
    { name: 'intranet.example.test', type: 'A', content: '10.0.0.5', proxied: false },
    { name: 'cdn.example.test', type: 'CNAME', content: 'origin.example.net', proxied: true },
    { name: 'raw.example.test', type: 'CNAME', content: 'origin.example.net', proxied: false },
    { name: 'example.test', type: 'MX', content: 'mail.example.test', proxied: false },
  ]);
  assert.deepEqual(leaks.map((l) => [l.record.name, l.why]), [['www.example.test', 'same-name'], ['direct.example.test', 'same-ip'], ['raw.example.test', 'same-target']]);
  assert.deepEqual(originLeaks([{ name: 'a.example.test', type: 'A', content: '192.0.2.1', proxied: false }]), [], 'nothing proxied: nothing to leak');
});

test('compareDelegation', () => {
  const cf = ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
  assert.equal(compareDelegation(cf, ['BOB.ns.cloudflare.com.', 'ada.ns.cloudflare.com']).state, 'ok');
  assert.equal(compareDelegation(cf, ['ns1.other.test', 'ns2.other.test']).state, 'elsewhere');
  const extra = compareDelegation(cf, [...cf, 'ns1.other.test']);
  assert.equal(extra.state, 'extra');
  assert.deepEqual(extra.extra, ['ns1.other.test']);
  assert.equal(compareDelegation(cf, ['ada.ns.cloudflare.com']).state, 'missing');
  assert.equal(compareDelegation(cf, []).state, 'unknown');
});

test('compareDnssec', () => {
  const ds = ['2371 13 2 1F987CC6583E92DF0890718C42'];
  assert.deepEqual(dsKeyTags(ds), [2371]);
  assert.equal(compareDnssec('disabled', null, ds), 'broken-disabled');
  assert.equal(compareDnssec('', null, []), 'off');
  assert.equal(compareDnssec('active', 2371, ds), 'ok');
  assert.equal(compareDnssec('active', 4242, ds), 'mismatch');
  assert.equal(compareDnssec('active', 2371, []), 'no-ds');
  assert.equal(compareDnssec('pending', 2371, []), 'pending');
  assert.equal(compareDnssec(null, null, ds), 'unknown');
  assert.equal(compareDnssec('active', 2371, null), 'unknown');
});

test('explain lists what took points off', () => {
  const lines = explain({ findings: { penalty: 35, bySeverity: { critical: 1, high: 1 }, byCheck: { dns: 35 } }, coverage: { penalty: 3, units: 12, failing: 1, never: 0 }, certificates: { penalty: 15, minDays: 5 }, drift: { penalty: 0, changes: 0 } });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /1 critical, 1 high.*−35.*dns −35/);
  assert.match(lines[1], /1 check failing of 12: −3/);
  assert.match(lines[2], /expires in 5 days: −15/);
  assert.deepEqual(explain({}), []);
});
