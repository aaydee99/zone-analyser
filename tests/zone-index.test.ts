import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  backupRows, backupZone, cleanItems, diffBackups, diffZones, dnsValue, evaluate, ipQuery, leaves, monitorRows, normZone, parseDnsLine,
  parseHcl, relName, rowIp, snapshotRows, templateFrom, type StoredRow,
} from '@/lib/zone-index';

const ZONE = 'example.com';
const ZID = '0123456789abcdef0123456789abcdef';

const DNS = `resource "cloudflare_dns_record" "terraform_managed_resource_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_0" {
  content = "192.0.2.10"
  name    = "www.example.com"
  proxied = true
  ttl     = 1
  type    = "A"
  zone_id = "${ZID}"
  settings = {
    flatten_cname = false
  }
}

resource "cloudflare_dns_record" "terraform_managed_resource_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_1" {
  content = "origin.example.net"
  name    = "example.com"
  type    = "CNAME"
  zone_id = "${ZID}"
}
`;

const RULESET = `resource "cloudflare_ruleset" "terraform_managed_resource_cccccccccccccccccccccccccccccccc_0" {
  kind    = "zone"
  name    = "default"
  phase   = "http_request_firewall_custom"
  zone_id = "${ZID}"
  rules = [{
    action      = "block"
    description = "Block bad"
    enabled     = true
    expression  = "(ip.src in {198.51.100.0/24} and http.host eq \\"www.example.com\\")"
    ref         = "dddddddddddddddddddddddddddddddd"
  }, {
    action = "rewrite"
    action_parameters = {
      headers = {
        "X-Frame-Options" = {
          operation = "set"
          value     = "DENY"
        }
      }
    }
    expression = "true"
  }]
}

resource "cloudflare_ruleset" "terraform_managed_resource_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee_1" {
  kind  = "zone"
  phase = "http_request_dynamic_redirect"
  rules = [{
    action = "redirect"
    action_parameters = {
      from_value = {
        status_code = 301
        target_url = {
          value = "https://www.example.com/new"
        }
      }
    }
    expression = "http.request.uri.path eq \\"/old\\""
  }]
}
`;

const SETTINGS = `resource "cloudflare_zone_setting" "terraform_managed_resource_ssl_0" {
  setting_id = "ssl"
  zone_id    = "${ZID}"
  value      = "full"
}

resource "cloudflare_zone_setting" "terraform_managed_resource_security_header_1" {
  setting_id = "security_header"
  zone_id    = "${ZID}"
  value = {
    strict_transport_security = {
      enabled = true
      max_age = 31536000
    }
  }
}
`;

const OTHER = `resource "cloudflare_workers_route" "terraform_managed_resource_ffffffffffffffffffffffffffffffff_0" {
  pattern = "example.com/api/*"
  script  = "api-worker"
  zone_id = "${ZID}"
}

resource "cloudflare_page_rule" "terraform_managed_resource_11111111111111111111111111111111_0" {
  priority = 1
  status   = "active"
  target   = "example.com/old/*"
  zone_id  = "${ZID}"
  actions = {
    forwarding_url = {
      status_code = 301
      url         = "https://www.example.com/$1"
    }
  }
}

resource "cloudflare_zero_trust_access_service_token" "terraform_managed_resource_22222222222222222222222222222222_0" {
  account_id    = "33333333333333333333333333333333"
  name          = "svc"
  client_secret = "not-a-real-secret"
}

resource "cloudflare_snippet" "terraform_managed_resource_44444444444444444444444444444444_0" {
  name    = "snip"
  zone_id = "${ZID}"
  api_token = "also-not-real"
  files = [{
    content = <<EOT
export default { fetch() {} }
EOT
    name = "main.js"
  }]
}

resource "cloudflare_zone" "terraform_managed_resource_${ZID}_0" {
  name = "example.com"
  account = {
    id = "55555555555555555555555555555555"
  }
}
`;

const FILES = [
  { name: 'cloudflare_dns_record.tf', text: DNS },
  { name: 'cloudflare_ruleset.tf', text: RULESET },
  { name: 'cloudflare_zone_setting.tf', text: SETTINGS },
  { name: 'other.tf', text: OTHER },
  { name: 'provider.tf', text: 'terraform {}' },
];

test('parseHcl reads nested objects, lists of objects, escapes, heredocs and quoted keys', () => {
  const [r1, r2] = parseHcl(RULESET);
  assert.equal(r1.type, 'cloudflare_ruleset');
  const rules = r1.body.rules as Record<string, unknown>[];
  assert.equal(rules.length, 2);
  assert.equal(rules[0].expression, '(ip.src in {198.51.100.0/24} and http.host eq "www.example.com")');
  assert.deepEqual((rules[1].action_parameters as { headers: Record<string, unknown> }).headers['X-Frame-Options'], { operation: 'set', value: 'DENY' });
  assert.equal(((r2.body.rules as Record<string, Record<string, Record<string, unknown>>>[])[0].action_parameters.from_value.status_code), 301);
  const snip = parseHcl(OTHER).find((r) => r.type === 'cloudflare_snippet')!;
  assert.equal((snip.body.files as Record<string, unknown>[])[0].content, 'export default { fetch() {} }');
  assert.deepEqual(parseHcl('resource "x" "y" {\n  a = "unterminated\n}\n'), [], 'a broken block is skipped');
  assert.deepEqual(parseHcl('resource "a_b" "c" {\n  n = 1\n  blk {\n    x = "y"\n  }\n  blk {\n    x = "z"\n  }\n}\n')[0].body, { n: 1, blk: [{ x: 'y' }, { x: 'z' }] });
  assert.equal(parseHcl('resource "a_b" "c" {\n  s = "$${x} %%{y}"\n}\n')[0].body.s, '${x} %{y}');
});

test('backupRows flattens a zone into searchable rows, without secrets or account-level resources', () => {
  const rows = backupRows(FILES, ZONE);
  const find = (item: string) => rows.filter((r) => r.item === item);
  assert.deepEqual(find('dns:A:www')[0], { kind: 'dns', item: 'dns:A:www', path: 'DNS A www.example.com', subject: 'www.example.com', value: '192.0.2.10' });
  assert.equal(find('dns:CNAME:@')[0].value, 'origin.example.net');
  assert.equal(find('setting:ssl')[0].value, 'full');
  assert.equal(find('setting:security_header')[0].value, '{"strict_transport_security":{"enabled":true,"max_age":31536000}}');
  const expr = find('ruleset:http_request_firewall_custom:1:expression')[0];
  assert.equal(expr.kind, 'rule');
  assert.equal(expr.path, 'Ruleset http_request_firewall_custom rule 1 expression');
  assert.equal(expr.subject, 'Block bad');
  const header = rows.find((r) => r.kind === 'header' && r.path.endsWith('value'))!;
  assert.equal(header.subject, 'X-Frame-Options');
  assert.equal(header.value, 'DENY');
  assert.ok(rows.some((r) => r.kind === 'redirect' && r.value === 'https://www.example.com/new'));
  assert.ok(rows.some((r) => r.kind === 'redirect' && r.value === 'https://www.example.com/$1' && r.path.startsWith('Page Rule 1')));
  assert.ok(rows.some((r) => r.kind === 'pagerule' && r.value === 'example.com/old/*'));
  assert.ok(rows.some((r) => r.kind === 'worker_route' && r.value === 'example.com/api/*' && r.subject === 'api-worker'));
  assert.ok(!rows.some((r) => /ref$|zone_id/.test(r.item)), 'no bookkeeping');
  assert.ok(!rows.some((r) => /not-a-real|also-not-real/.test(r.value)), 'no secrets');
  assert.ok(!rows.some((r) => r.item.startsWith('zero_trust')), 'no account-level resources');
  assert.ok(rows.some((r) => r.item === 'snippet:snip:files[0].content'));
  assert.deepEqual(backupZone(FILES), { zoneId: ZID, accountId: '55555555555555555555555555555555' });
});

test('snapshotRows and monitorRows use the same items as backups', () => {
  const rows = snapshotRows({
    settings: { ssl: 'full', security_header: '{"strict_transport_security":{"max_age":31536000,"enabled":true}}' },
    rulesets: { r1: { name: 'default', phase: 'http_request_firewall_custom', version: '3' } },
    dns: ['www.example.com. 300 IN A 192.0.2.10', 'example.com. 1 IN MX 10 mail.example.com.', 'txt.example.com. 1 IN TXT "v=spf1 -all"'],
    dnssec: 'active',
  }, ZONE);
  const backup = backupRows(FILES, ZONE);
  const val = (list: { item: string; value: string }[], item: string) => list.find((r) => r.item === item)?.value;
  assert.equal(val(rows, 'setting:security_header'), val(backup, 'setting:security_header'), 'key order does not matter');
  assert.equal(val(rows, 'dns:A:www'), '192.0.2.10');
  assert.equal(val(rows, 'dns:MX:@'), 'mail.example.com');
  assert.equal(val(rows, 'dns:TXT:txt'), 'v=spf1 -all');
  assert.equal(val(rows, 'setting:dnssec'), 'active');
  const m = monitorRows('certificates', { certificates: [{ kind: 'Edge · universal', name: 'example.com, *.example.com', where: ZONE }] }, ZONE);
  assert.deepEqual(m.map((r) => r.item), ['certificate:Edge · universal:@', 'certificate:Edge · universal:*']);
  assert.equal(monitorRows('pagerules', { rules: [{ url: 'example.com/*', setting: 'forwarding_url', value: '{"url":"https://example.net"}' }] }, ZONE)[1].kind, 'redirect');
  assert.deepEqual(monitorRows('governance', { tokens: [{ name: 'x' }] }, ZONE), []);
});

test('helpers: names, values, addresses', () => {
  assert.equal(relName('WWW.Example.com.', ZONE), 'www');
  assert.equal(relName('example.com', ZONE), '@');
  assert.equal(relName('other.test', ZONE), 'other.test');
  assert.equal(normZone('https://www.example.com/x and example.com', ZONE), 'https://www.{zone}/x and {zone}');
  assert.equal(normZone('notexample.com', ZONE), 'notexample.com');
  assert.equal(dnsValue('CNAME', 'Target.Example.NET.'), 'target.example.net');
  assert.deepEqual(parseDnsLine('a.example.com. IN AAAA 2001:db8::1'), { name: 'a.example.com', type: 'AAAA', value: '2001:db8::1' });
  assert.equal(ipQuery('192.0.2.0/24'), '192.0.2.0/24');
  assert.equal(ipQuery('2001:DB8::1'), '2001:db8::1');
  assert.equal(ipQuery('999.1.1.1'), null);
  assert.equal(ipQuery('www.example.com'), null);
  assert.equal(ipQuery('cafe'), null);
  assert.equal(rowIp({ value: '203.0.113.5' }), '203.0.113.5');
  assert.equal(rowIp({ value: '203.0.113.0/24' }), null);
  assert.deepEqual(leaves({ a: { b: [1, 2], client_secret: 'x', ref: 'r' }, c: [{ d: 'e' }] }), [['a.b', '1, 2'], ['c[0].d', 'e']]);
});

test('diffBackups reports added, removed and changed resources by attribute', () => {
  const before = [{ name: 'a.tf', text: SETTINGS + DNS }];
  const after = [{ name: 'a.tf', text: SETTINGS.replace('"full"', '"strict"') + DNS.split('\n\n')[0] + '\n' + OTHER.split('\n\n')[0] + '\n' }];
  const { changes, unchanged } = diffBackups(before, after);
  const ssl = changes.find((c) => c.type === 'cloudflare_zone_setting')!;
  assert.equal(ssl.change, 'changed');
  assert.deepEqual(ssl.attrs, [{ path: 'value', before: 'full', after: 'strict' }]);
  assert.ok(changes.some((c) => c.change === 'removed' && c.type === 'cloudflare_dns_record'));
  assert.ok(changes.some((c) => c.change === 'added' && c.type === 'cloudflare_workers_route'));
  assert.equal(unchanged, 2, 'security_header and the A record');
});

const stored = (rows: ReturnType<typeof backupRows>, source = 'backup', at = '2026-10-01T00:00:00.000Z'): StoredRow[] => rows.map((r) => ({ ...r, source, sourceAt: at }));

test('diffZones ignores the zone name, and the newest source wins', () => {
  const a = stored(backupRows(FILES, ZONE));
  const otherFiles = FILES.map((f) => ({ ...f, text: f.text.replaceAll('example.com', 'example.org').replace('"full"', '"flexible"') }));
  const b = stored(backupRows(otherFiles, 'example.org'));
  const { diffs } = diffZones(a, ZONE, b, 'example.org');
  assert.deepEqual(diffs.map((d) => d.item), ['setting:ssl'], 'only the real difference');
  assert.deepEqual(diffs[0].a, ['full']);
  // A newer drift snapshot replaces the backup's value of the same item.
  const newer = [...a, ...stored(snapshotRows({ settings: { ssl: 'flexible' } }, ZONE), 'drift', '2026-10-02T00:00:00.000Z')];
  assert.equal(diffZones(newer, ZONE, b, 'example.org').diffs.length, 0);
});

test('templates: made from a zone, then each zone checked against it', () => {
  const rows = stored(backupRows(FILES, ZONE));
  const items = templateFrom(rows, ZONE, ['setting', 'header']);
  assert.ok(items.every((i) => i.kind === 'setting' || i.kind === 'header'));
  assert.ok(items.some((i) => i.item === 'setting:ssl' && i.expected === 'full' && i.match === 'equals'));
  assert.deepEqual(evaluate(items, rows, ZONE), [], 'its own zone matches');
  const other = stored(backupRows([{ name: 's.tf', text: SETTINGS.replace('"full"', '"off"') }], 'example.org'));
  const gaps = evaluate(items, other, 'example.org');
  assert.ok(gaps.some((g) => g.item === 'setting:ssl' && g.problem === 'different' && g.actual[0] === 'off'));
  assert.ok(gaps.some((g) => g.problem === 'missing' && g.item.includes('X-Frame-Options')));
  const custom = cleanItems([{ item: 'setting:ssl', expected: 'of', match: 'contains' }, { item: 'dns:A:www', match: 'absent' }, { item: '' }, { item: 'setting:ssl' }, 'junk']);
  assert.equal(custom.length, 2);
  assert.deepEqual(evaluate(custom, other, 'example.org'), [], '"off" contains "of", and there is no A record');
  assert.equal(evaluate(custom, rows, ZONE).map((g) => g.problem).join(), 'different,unexpected');
});
