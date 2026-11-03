import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { ALL_RULES, buildReport } from '@/lib/zone-audit/report';
import { CF_MANAGED } from '@/lib/zone-audit/rules';
import { bannedIn, clean, clientReport, themeOf } from '@/lib/zone-audit/client-report';
import { clientReportDocx } from '@/lib/zone-audit/client-report-docx';
import type { EventData, Got, RequestData, Snapshot, SourceKey } from '@/lib/zone-audit/types';

// The client version of an audit ("Gaps and recommendations"): every finding in one gap, the
// critical-review rules, and nothing internal in the Word file itself. Test data only (example.test,
// documentation address ranges).

const OWASP = '4814384a9e5d4991b9815dcfc25d2f1f';
const NOW = '2026-11-01T00:00:00.000Z';
const days = (n: number) => new Date(Date.parse(NOW) + n * 86_400_000).toISOString();
const evData = (o: Partial<EventData> = {}): EventData => ({ since: days(-7), until: NOW, rules: [], paths: [], countries: [], asns: [], ips: [], uas: [], statuses: null, hours: null, bots: null, attacks: null, notes: [], ...o });
const rqData = (o: Partial<RequestData> = {}): RequestData => ({ since: days(-7), until: NOW, paths: [], asns: [], notes: [], ...o });
const OKHTTP = 'okhttp/4.12.0', PY = 'python-requests/2.31';

/** A zone with many gaps, and two log rules: device traffic to /api from ISP networks, and scrapers from a hosting network that fail often. */
export function messyZone(): Snapshot {
  const c1 = 'c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', c2 = 'c2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const r: Record<string, unknown> = {
    zone: { id: 'f3c0ffee0000000000000000000000aa', name: 'shop.example.test', status: 'active', type: 'full', plan: 'business' },
    'setting:ssl': { value: 'flexible' }, 'setting:min_tls_version': { value: '1.0' }, 'setting:tls_1_3': { value: 'off' }, 'setting:always_use_https': { value: 'off' },
    'setting:automatic_https_rewrites': { value: 'on' }, 'setting:security_header': { value: { strict_transport_security: { enabled: false } } },
    'setting:security_level': { value: 'medium' }, 'setting:browser_check': { value: 'on' }, 'setting:development_mode': { value: 'off' }, 'setting:true_client_ip_header': { value: 'off' }, 'setting:cache_level': { value: 'aggressive' },
    'setting:0rtt': { value: 'off' }, 'setting:opportunistic_encryption': { value: 'on' }, 'setting:email_obfuscation': { value: 'on' }, 'setting:hotlink_protection': { value: 'on' },
    'setting:server_side_exclude': { value: 'on' }, 'setting:challenge_ttl': { value: 1800 }, 'setting:websockets': { value: 'off' }, 'setting:ip_geolocation': { value: 'on' }, 'setting:ssl_automatic_mode': { value: 'custom' },
    'phase:http_response_firewall_managed': [], 'phase:http_config_settings': [], 'phase:http_request_late_transform': [], access_apps: [], turnstile_widgets: [],
    access_rules: [], account_access_rules: [], lockdowns: [], ua_rules: [], universal_ssl: { enabled: true }, leaked_credentials: { enabled: false },
    schema_validation: { validation_default_mitigation_action: 'none' }, api_operations: { total: 0 },
    'phase:http_request_firewall_custom': [
      { id: c1, description: 'Watch API', action: 'log', expression: '(http.request.uri.path contains "/api")' },
      { id: c2, description: 'Watch shop', action: 'log', expression: '(http.request.uri.path contains "/shop")' },
    ],
    'phase:http_request_firewall_managed': [{ id: 'm-dep', action: 'execute', expression: 'true', action_parameters: { id: CF_MANAGED } },
      { id: 'o-dep', action: 'execute', expression: 'true', action_parameters: { id: OWASP, overrides: { action: 'log' } } }],
    'phase:http_ratelimit': [], 'phase:ddos_l7': [], 'phase:http_request_cache_settings': [], 'phase:http_request_origin': [], 'phase:http_response_headers_transform': [],
    dns: [
      { name: 'shop.example.test', type: 'A', content: '192.0.2.10', proxied: true },
      { name: 'direct.shop.example.test', type: 'A', content: '192.0.2.10', proxied: false },
      { name: 'admin.shop.example.test', type: 'A', content: '198.51.100.7', proxied: false },
      { name: 'old.shop.example.test', type: 'CNAME', content: 'gone-app.herokuapp.com', proxied: false },
      { name: 'shop.example.test', type: 'TXT', content: '"v=spf1 include:_spf.example.net -all"' },
    ],
    dnssec: { status: 'disabled' },
    certificates: [{ id: 'p1', type: 'universal', status: 'active', hosts: ['shop.example.test', '*.shop.example.test'], certificates: [{ expires_on: days(60) }] }],
    aop: { enabled: false }, bot: { fight_mode: false }, page_shield: { enabled: false }, page_rules: [], worker_routes: [],
    managed_headers: { managed_response_headers: [] },
    cname_lookups: { answers: { 'gone-app.herokuapp.com': 3 }, skipped: 0 },
    events: evData({
      rules: [
        { ruleId: c1, rulesetId: 'rs-c', source: 'firewallCustom', action: 'log', description: 'Watch API', count: 9000 },
        { ruleId: c2, rulesetId: 'rs-c', source: 'firewallCustom', action: 'log', description: 'Watch shop', count: 1200 },
        { ruleId: 'm1', rulesetId: CF_MANAGED, source: 'firewallManaged', action: 'block', description: 'SQLi', count: 40 },
        { ruleId: '6179ae15870a4bb7b2d480d4843b323c', rulesetId: OWASP, source: 'firewallManaged', action: 'log', description: '949110: Inbound Anomaly Score Exceeded', count: 700 },
      ],
      asns: [
        { ruleId: c1, source: 'firewallCustom', action: 'log', asn: '7922', name: 'COMCAST-7922', count: 5000 },
        { ruleId: c1, source: 'firewallCustom', action: 'log', asn: '64512', name: 'EXAMPLE-ENTERPRISE', count: 4000 },
        { ruleId: c2, source: 'firewallCustom', action: 'log', asn: '16509', name: 'AMAZON-02', count: 1200 },
      ],
      uas: [{ ruleId: c1, source: 'firewallCustom', action: 'log', ua: OKHTTP, count: 9000 }, { ruleId: c2, source: 'firewallCustom', action: 'log', ua: PY, count: 1200 }],
      paths: [
        { ruleId: c1, source: 'firewallCustom', action: 'log', host: 'shop.example.test', path: '/api/v1/devices/sync', count: 6000 },
        { ruleId: c1, source: 'firewallCustom', action: 'log', host: 'shop.example.test', path: '/api/v1/status', count: 3000 },
        { ruleId: c2, source: 'firewallCustom', action: 'log', host: 'shop.example.test', path: '/shop/cart', count: 1200 },
        { ruleId: '6179ae15870a4bb7b2d480d4843b323c', source: 'firewallManaged', action: 'log', host: 'shop.example.test', path: '/search', count: 700 },
      ],
      ips: [{ ruleId: c2, source: 'firewallCustom', action: 'log', ip: '203.0.113.9', count: 1200 }],
      statuses: [{ ruleId: c2, source: 'firewallCustom', action: 'log', status: 404, count: 800 }, { ruleId: c2, source: 'firewallCustom', action: 'log', status: 200, count: 400 },
        { ruleId: c1, source: 'firewallCustom', action: 'log', status: 200, count: 9000 }],
    }),
    events_previous: evData(),
    requests: rqData({ paths: [{ host: 'shop.example.test', path: '/', status: 200, count: 20000 }, { host: 'shop.example.test', path: '/api/v1/devices/sync', status: 200, count: 6000 }],
      asns: [{ asn: '7922', name: 'COMCAST-7922', status: 200, count: 20000 }] }),
  };
  const reads: Snapshot['reads'] = {};
  for (const [k, v] of Object.entries(r)) reads[k as SourceKey] = { state: 'ok', value: v } as Got<unknown>;
  return { zoneId: 'f3c0ffee0000000000000000000000aa', zoneName: 'shop.example.test', now: NOW, reads, hours: 168, askedHours: 168 };
}
export const messyReport = () => buildReport(messyZone(), { accountId: 'a1', accountName: 'Example Retail', startedAt: NOW, finishedAt: NOW, calls: 0, lookups: 0 });

/** Every text of the client report (what goes into the document). */
const allText = (c: ReturnType<typeof clientReport>) => JSON.stringify({ ...c, departures: [], checks: [] });

/** The text of word/document.xml (and headers and footers) from a .docx (a zip). */
function docxText(buf: Buffer): string {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  let out = '';
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), note = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      out += (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8').replace(/<[^>]+>/g, ' ');
    }
    at += 46 + nameLen + extra + note;
  }
  return out.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

test('every finding is in exactly one gap, at most 15, numbered worst first', () => {
  const r = messyReport();
  const c = clientReport(r, { client: 'Example Retail' });
  assert.ok(r.findings.length >= 10, `${r.findings.length} findings`);
  assert.equal(c.gaps.reduce((n, g) => n + g.findings, 0), r.findings.length);
  assert.ok(c.gaps.length <= 15 && c.gaps.length >= 5, `${c.gaps.length} gaps`);
  assert.deepEqual(c.gaps.map((g) => g.id), c.gaps.map((_, i) => `G${i + 1}`));
  for (let i = 1; i < c.gaps.length; i++) assert.ok(c.gaps[i - 1].rank >= c.gaps[i].rank, 'worst first');
  assert.equal(c.executive.counts.reduce((n, x) => n + x.findings, 0), r.findings.length);
  assert.equal(c.fileName, 'shop.example.test-Gaps-and-Recommendations.docx');
});

test('device traffic is not sent to a challenge; scrapers still are', () => {
  const c = clientReport(messyReport(), { client: 'Example Retail' });
  const card = (s: string) => c.gaps.find((g) => g.rows.some((r) => r.lines.some((l) => l.includes(s))));
  const api = card('/api/v1/devices/sync');
  assert.ok(api, 'the API traffic is in a gap');
  const rec = api!.rows.find((r) => r.label === 'Recommendation')!.lines.join(' ');
  assert.match(rec, /For "Watch API", classify this traffic first/);
  // The scrapers' rule (hosting network, python) keeps the audit's challenge.
  assert.match(rec, /Watch shop[\s\S]*Managed Challenge|Managed Challenge[\s\S]*Watch shop/);
  assert.equal(api!.status, 'To validate');
  assert.ok(api!.rows.find((r) => r.label === 'Before rollout')!.lines.some((l) => /cannot complete one/.test(l)));
  assert.ok(c.departures.some((d) => /classify the traffic first/.test(d)));
  // Sentences read as sentences: rule IDs became rule names, and every line starts with a capital or a quote.
  for (const g of c.gaps) for (const row of g.rows) for (const l of row.lines) assert.match(l, /^["“A-Z0-9/_]|^(?:[a-z0-9-]+\.)+[a-z]+\b/, `${g.id} ${row.label}: ${l}`);
  // A hostname at the start of a line keeps its case.
  assert.ok(c.gaps.some((g) => g.rows.some((r) => r.lines.some((l) => l.startsWith('direct.shop.example.test')))), 'hostnames are not capitalised');
  assert.ok(api!.rows.find((r) => r.label === 'Risk')!.lines.some((l) => l.includes('"Watch API"')), 'the rule is named, not its ID');
  assert.ok(c.roadmap.inputs.some((x) => /devices, apps and partner integrations/.test(x)));
});

test('rollout order, failing paths and threat statuses follow the review rules', () => {
  const c = clientReport(messyReport(), { client: 'Example Retail' });
  const text = (id: string) => c.gaps.find((g) => g.themeId === id)?.rows.flatMap((r) => r.lines).join(' ') ?? '';
  assert.match(text('origin_tls'), /Full \(strict\)/);
  assert.match(text('origin'), /before proxying a DNS-only record/);
  assert.match(text('managed_log'), /exceptions for the legitimate matches before removing a ruleset-wide Log override/);
  assert.ok(c.gaps.some((g) => g.rows.some((r) => r.label === 'Before rollout' && r.lines.some((l) => /4xx errors/.test(l)))), 'failing paths caveat');
  for (const t of c.threats) if (t.status === 'Covered') assert.equal(t.mainGap, 'None found.', `${t.threat} is Covered but ${t.mainGap}`);
  const order = c.roadmap.phases.flatMap((p) => p.items);
  const at = (title: string) => order.findIndex((x) => x.includes(title));
  if (at('Encryption between Cloudflare and the origin') >= 0 && at('Origin exposure') >= 0) assert.ok(at('Encryption between Cloudflare and the origin') < at('Origin exposure') || c.gaps.find((g) => g.themeId === 'origin')?.phase === 1);
  assert.ok(c.appendices.some((a) => a.title === 'Logged rule matches'));
  assert.ok(c.appendices.some((a) => a.title === 'Paths with failing requests'));
});

test('nothing internal: no tool name, IDs, slugs, commands, addresses, grade or dashes', () => {
  const r = messyReport();
  const c = clientReport(r, { client: 'Example Retail' });
  const t = allText(c);
  assert.deepEqual(bannedIn(t, [r.zone.id, '192.0.2.10', '198.51.100.7', '203.0.113.9']), []);
  assert.doesNotMatch(t, /\b(?:tls|origin|waf|traffic|managed|bots|avail|access|email|dns|cache|client|host|api|edge|bypass)\.[a-z_]+[a-z0-9]\b(?!\.)/i, 'no rule slugs');
  assert.doesNotMatch(t, /\b(?:grade|score of|\/100)\b/i);
  assert.doesNotMatch(t, /GET \//);
});

test('clean() rewrites the audit wording', () => {
  assert.equal(clean('Run `curl -sI http://x/` — a 301 settles it'), 'Run a test request, a 301 settles it');
  assert.equal(clean('15–30 minutes'), '15 to 30 minutes');
  assert.equal(clean('Origin 192.0.2.10 answers', new Set()), 'Origin a published address answers');
  assert.equal(clean('See waf.owasp (see tls.ssl_mode).', new Set(['waf.owasp'])), 'See.');
  assert.equal(clean('api.example.test stays'), 'api.example.test stays');
  // Cloudflare fields that look like rule IDs stay intact in expressions.
  assert.equal(clean('not (cf.waf.score lt 21)', new Set(['waf.owasp'])), 'not (cf.waf.score lt 21)');
  assert.equal(clean('Check traffic.zero_hits now', new Set(['traffic.zero_hits'])), 'Check now');
});

test('the Word file holds the sections and nothing internal', async () => {
  const r = messyReport();
  const c = clientReport(r, { client: 'Example Retail', preparedOn: new Date('2026-11-03T15:00:00Z') });
  const buf = await clientReportDocx(c);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const text = docxText(buf);
  for (const s of ['Cloudflare Security Review', 'Gaps and recommendations', 'Prepared for Example Retail', 'Prepared by Adapture', 'November 3, 2026', 'Executive summary', 'Scope and approach',
    'Current coverage by threat', 'Summary of gaps', 'Recommended roadmap', 'What is working well', 'Appendix A', 'Adapture | Confidential | Page', 'G1.', 'Before rollout']) assert.ok(text.includes(s), `missing: ${s}`);
  assert.deepEqual(bannedIn(text, [r.zone.id, '192.0.2.10', '198.51.100.7', '203.0.113.9', 'Castellan']), []);
});

test('every audit rule has a gap theme, and no two gaps share a title', () => {
  assert.deepEqual(ALL_RULES.filter((r) => !themeOf(r.id)).map((r) => r.id), []);
  const c = clientReport(messyReport(), { client: 'Example Retail' });
  assert.equal(new Set(c.gaps.map((g) => g.title)).size, c.gaps.length);
});
