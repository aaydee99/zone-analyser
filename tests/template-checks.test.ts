import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backupRows, cleanItems, evaluate, valueMatches, type StoredRow, type TemplateItem } from '@/lib/zone-index';
import { CF_MANAGED_ID, LIBRARY, LIBRARY_GROUPS, OWASP_ID, PHASES, libraryItems } from '@/lib/template-library';

// Templates checked against a zone's backup: rule checks (any rule of a phase, wherever it sits),
// [*] list positions, numbers and versions, "no rule" checks, and the best-practice library. Test data only.

const ZID = '0123456789abcdef0123456789abcdef';
const ZONE = 'example.test';
const ruleset = (n: number, phase: string, rules: string) => `resource "cloudflare_ruleset" "terraform_managed_resource_${String(n).repeat(32)}_0" {
  kind    = "zone"
  phase   = "${phase}"
  zone_id = "${ZID}"
  rules = [${rules}]
}
`;
const GOOD = [
  ruleset(1, 'http_request_firewall_custom', `{
    action      = "log"
    description = "Watch"
    expression  = "true"
  }, {
    action      = "managed_challenge"
    description = "Bots"
    expression  = "(cf.bot_management.score lt 30 and not cf.bot_management.verified_bot)"
  }`),
  ruleset(2, 'http_ratelimit', `{
    action      = "block"
    description = "Login"
    expression  = "(http.request.uri.path eq \\"/login\\")"
    ratelimit = {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = 60
      requests_per_period = 5
    }
  }`),
  ruleset(3, 'http_request_firewall_managed', `{
    action = "execute"
    action_parameters = {
      id = "${CF_MANAGED_ID}"
    }
    expression = "true"
  }, {
    action = "execute"
    action_parameters = {
      id = "${OWASP_ID}"
      overrides = {
        rules = [{
          id              = "6179ae15870a4bb7b2d480d4843b323c"
          action          = "block"
          score_threshold = 25
        }]
      }
    }
    expression = "true"
  }`),
  ruleset(4, 'http_response_headers_transform', `{
    action = "rewrite"
    action_parameters = {
      headers = {
        "X-Frame-Options" = {
          operation = "set"
          value     = "SAMEORIGIN"
        }
      }
    }
    expression = "true"
  }`),
  `resource "cloudflare_zone_setting" "a" {
  setting_id = "min_tls_version"
  value      = "1.3"
  zone_id    = "${ZID}"
}
resource "cloudflare_zone_setting" "b" {
  setting_id = "ssl"
  value      = "strict"
  zone_id    = "${ZID}"
}
resource "cloudflare_zone_setting" "c" {
  setting_id = "security_level"
  value      = "medium"
  zone_id    = "${ZID}"
}
`,
].join('\n');

const rowsOf = (text: string): StoredRow[] => backupRows([{ name: 'z.tf', text }], ZONE).map((r) => ({ ...r, source: 'backup:x', sourceAt: '2026-11-01T00:00:00.000Z' }));
const good = rowsOf(GOOD);
const byId = (id: string) => LIBRARY.find((e) => e.id === id)!.item;
const gapsOf = (items: TemplateItem[], rows = good) => evaluate(items, rows, ZONE);

test('numbers and versions compare part by part; one_of and not_equals', () => {
  assert.ok(valueMatches('1.3', 'at_least', '1.2'));
  assert.ok(!valueMatches('1.0', 'at_least', '1.2'));
  assert.ok(valueMatches('1.10', 'at_least', '1.9'), 'a version, not a decimal');
  assert.ok(valueMatches('25', 'at_most', '40'));
  assert.ok(!valueMatches('on', 'at_least', '1'), 'text is not a number');
  assert.ok(valueMatches('Managed_Challenge', 'one_of', 'block, managed_challenge'));
  assert.ok(valueMatches('medium', 'not_equals', 'under_attack'));
});

test('a rule check finds a rule of its phase wherever it sits, with [*] list positions', () => {
  const items = ['cf-managed', 'owasp', 'owasp-threshold', 'owasp-action', 'bot-score-rule', 'rl-login', 'hdr-frame', 'ssl-strict', 'min-tls', 'not-under-attack', 'no-skip-all-custom', 'rl-not-log'].map(byId);
  assert.deepEqual(gapsOf(items), [], JSON.stringify(gapsOf(items), null, 1));
});

test('what is missing or wrong is a gap that says which rule came closest and what it lacks', () => {
  const weak = rowsOf(GOOD.replace('score_threshold = 25', 'score_threshold = 60').replace('"1.3"', '"1.0"').replace('action      = "block"\n    description = "Login"', 'action      = "log"\n    description = "Login"'));
  const g = Object.fromEntries(gapsOf(['owasp-threshold', 'min-tls', 'rl-login', 'rl-not-log', 'hdr-nosniff', 'cache-static'].map(byId), weak).map((x) => [x.item, x]));
  assert.equal(g['check:http_request_firewall_managed:owasp_threshold'].problem, 'different');
  assert.match(g['check:http_request_firewall_managed:owasp_threshold'].actual[0], /^rule 2: 1 of 2 conditions met \(action_parameters\.overrides\.rules\[\*\]\.score_threshold is 60\)$/);
  assert.equal(g['setting:min_tls_version'].problem, 'different');
  assert.deepEqual(g['setting:min_tls_version'].actual, ['1.0']);
  assert.match(g['check:http_ratelimit:login'].actual[0], /rule 1 “Login”: 1 of 2 conditions met \(action is log\)/);
  // A "no rule" check names the rule that breaks it.
  assert.equal(g['check:http_ratelimit:log_only'].problem, 'unexpected');
  assert.deepEqual(g['check:http_ratelimit:log_only'].actual, ['rule 1 “Login”']);
  // A header no rule sets; a phase the zone has no rules in.
  assert.equal(g['check:http_response_headers_transform:nosniff'].problem, 'different');
  assert.equal(g['check:http_request_cache_settings:static'].problem, 'missing');
  assert.deepEqual(g['check:http_request_cache_settings:static'].actual, ['no http_request_cache_settings rules stored']);
  assert.match(g['check:http_request_cache_settings:static'].expected, /expression contains http\.request\.uri\.path\.extension · action_parameters\.cache is true/);
});

test('a skip-everything rule breaks the "no rule" check', () => {
  const bad = rowsOf(GOOD.replace('action      = "log"\n    description = "Watch"', 'action      = "skip"\n    description = "Watch"'));
  const g = gapsOf([byId('no-skip-all-custom')], bad);
  assert.equal(g.length, 1);
  assert.equal(g[0].problem, 'unexpected');
  assert.deepEqual(g[0].actual, ['rule 1 “Watch”']);
});

test('cleanItems keeps rule checks (and drops broken ones); the library is valid and has every group', () => {
  const lib = libraryItems();
  assert.deepEqual(cleanItems(lib).map((x) => x.item), lib.map((x) => x.item), 'every library item survives cleaning');
  assert.equal(new Set(lib.map((x) => x.item)).size, lib.length, 'no two library items share a key');
  for (const g of LIBRARY_GROUPS) assert.ok(LIBRARY.some((e) => e.group === g), g);
  for (const e of LIBRARY) if (e.item.check) assert.ok(PHASES.some((p) => p.phase === e.item.check!.phase), e.id);
  const c = cleanItems([
    { item: 'check:http_ratelimit:x', check: { phase: 'http_ratelimit', when: [{ field: 'expression', match: 'contains', value: '/x' }, { field: 'bad field!', match: 'equals', value: 'y' }] } },
    { item: 'check:bad', check: { phase: 'Not A Phase', when: [{ field: 'action', value: 'block' }] } },
    { item: 'check:empty', check: { phase: 'http_ratelimit', when: [] } },
  ]);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].check, { phase: 'http_ratelimit', when: [{ field: 'expression', match: 'contains', value: '/x' }] });
  assert.equal(c[0].match, 'present');
  assert.equal(c[0].kind, 'rule');
  assert.equal(c[0].expected, 'expression contains /x');
});
