import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployOf, paranoiaOf, thresholdLabel, tuningLines, tuningOf } from '@/lib/waf-labels';
import { actionLabel } from '@/lib/waf-labels';
import { actionDetail } from '@/lib/zone-format';
import { currentActionOf, draftException, fixesOf } from '@/lib/waf-fp-score';
import { OWASP_ANOMALY_RULE, OWASP_RULESET } from '@/lib/traffic-types';

// OWASP tuning per developers.cloudflare.com/waf/managed-rules/reference/owasp-core-ruleset/ (concepts, configure-api).

const CF_MANAGED = 'efb7b8c949ac4650a09736fc376e9aee';
const LEAKED = 'c2e184081120413c86c3ab7e14069605';
const execute = (id: string, overrides?: unknown, extra: Record<string, unknown> = {}) => ({ id: 'deploy1', action: 'execute', expression: 'true', enabled: true, action_parameters: { id, ...(overrides ? { overrides } : {}) }, ...extra });

test('the paranoia level: below the lowest level turned off, else the highest turned on, else PL1', () => {
  assert.deepEqual(paranoiaOf([]), { level: 1, set: false });
  assert.deepEqual(paranoiaOf([{ category: 'paranoia-level-3', enabled: false }, { category: 'paranoia-level-4', enabled: false }]), { level: 2, set: true });
  assert.deepEqual(paranoiaOf([{ category: 'paranoia-level-2', enabled: false }, { category: 'paranoia-level-3', enabled: false }, { category: 'paranoia-level-4', enabled: false }]), { level: 1, set: true });
  assert.deepEqual(paranoiaOf([{ category: 'paranoia-level-2', enabled: true }, { category: 'paranoia-level-3', enabled: true }]), { level: 3, set: true });
  assert.equal(thresholdLabel(40), 'Medium — 40 and higher');
  assert.equal(thresholdLabel(25), 'High — 25 and higher');
  assert.equal(thresholdLabel(60), 'Low — 60 and higher');
});

test('managed rulesets are named, with their ruleset action and status, never just "execute"', () => {
  const t = tuningOf(deployOf(execute(CF_MANAGED, { action: 'managed_challenge', enabled: true, rules: [{ id: 'r1', action: 'log' }] }))!);
  assert.equal(t.name, 'Cloudflare Managed Ruleset');
  assert.deepEqual(tuningLines(t), [['Ruleset action', 'Managed challenge'], ['Ruleset status', 'Enabled — every rule on']]);
  assert.deepEqual(t.overrides, ['Rule r1: action Log']);
  const plain = tuningOf(deployOf(execute(LEAKED))!);
  assert.equal(plain.name, 'Cloudflare Exposed Credentials Check');
  assert.deepEqual(tuningLines(plain), [['Ruleset action', 'Default — each rule’s own action'], ['Ruleset status', 'Default — each rule as Cloudflare ships it']]);
  assert.match(tuningLines(tuningOf(deployOf(execute(CF_MANAGED, undefined, { enabled: false }))!))[1][1], /^Off/);
  assert.equal(deployOf({ action: 'block', expression: 'true' }), null);
});

test('OWASP shows its action, anomaly score threshold and paranoia level', () => {
  const dflt = tuningLines(tuningOf(deployOf(execute(OWASP_RULESET))!));
  assert.deepEqual(dflt.slice(0, 3), [['OWASP action', 'Block (default)'], ['Anomaly score threshold', 'Medium — 40 and higher (default)'], ['Paranoia level', 'PL1 (default)']]);
  const tuned = tuningOf(deployOf(execute(OWASP_RULESET, {
    categories: [{ category: 'paranoia-level-3', enabled: false }, { category: 'paranoia-level-4', enabled: false }, { category: 'wordpress', enabled: false }],
    rules: [{ id: OWASP_ANOMALY_RULE, score_threshold: 60, action: 'managed_challenge' }],
  }))!);
  assert.deepEqual(tuningLines(tuned).slice(0, 3), [['OWASP action', 'Managed challenge'], ['Anomaly score threshold', 'Low — 60 and higher'], ['Paranoia level', 'PL2']]);
  // The paranoia categories and 949110's threshold and action are the tuning above, not "overrides".
  assert.deepEqual(tuned.overrides, ['Category “wordpress”: off']);
  // The download text names the ruleset and its tuning.
  const text = actionDetail(execute(OWASP_RULESET, { rules: [{ id: OWASP_ANOMALY_RULE, score_threshold: 25 }] }), {});
  assert.match(text, /^runs Cloudflare OWASP Core Ruleset · OWASP action: Block \(default\) · Anomaly score threshold: High — 25 and higher · Paranoia level: PL1 \(default\)/);
  assert.doesNotMatch(text, new RegExp(OWASP_RULESET));
});

test('a false positive says what the rule does now and how to fix it, narrowest first', () => {
  assert.equal(currentActionOf({ block: 40, managed_challenge: 10, managed_challenge_non_interactive_solved: 90, log: 500 }), 'block');
  const base = { ruleId: 'r1', rulesetId: CF_MANAGED, source: 'firewallManaged', description: 'SQLi - Probing', rulesetName: 'Cloudflare Managed Ruleset', host: 'www.example.com', path: '/search', pathShare: 0.9 };
  const draft = draftException(base, ['/search']);
  const fixes = fixesOf({ ...base, currentAction: 'block', draft });
  assert.equal(fixes[0].best, true);
  assert.match(fixes[0].title, /skip “SQLi - Probing” on www\.example\.com\/search/);
  assert.ok(fixes[0].steps.some((s) => s.includes('http.request.uri.path eq "/search"')));
  assert.ok(fixes.some((f) => f.title === 'Change the action from Block to Managed challenge' && f.steps.some((s) => s.includes('Browse rules'))));
  assert.equal(fixes.at(-1)!.title, 'Turn this rule off');

  // OWASP: the exception, then its threshold, paranoia level and action as they are on the zone.
  const ob = { ...base, ruleId: OWASP_ANOMALY_RULE, rulesetId: OWASP_RULESET, description: '949110: Inbound Anomaly Score Exceeded', rulesetName: 'Cloudflare OWASP Core Ruleset' };
  const deploy = tuningOf(deployOf(execute(OWASP_RULESET, { categories: [{ category: 'paranoia-level-4', enabled: false }] }))!);
  const of = fixesOf({ ...ob, currentAction: 'block', draft: draftException(ob, ['/search']), deploy });
  assert.deepEqual(of.map((f) => f.title), [
    'Add an exception: skip OWASP scoring on www.example.com/search',
    'Lower OWASP’s sensitivity: anomaly score threshold Medium — 40 and higher → Low — 60 and higher',
    'Lower the paranoia level: PL3 → PL2',
    'Change the OWASP action from Block to Managed challenge',
  ]);
  // A challenge already: no "change to managed challenge".
  assert.ok(!fixesOf({ ...base, currentAction: 'managed_challenge', draft }).some((f) => /Managed challenge$/.test(f.title)));
  assert.equal(actionLabel('managed_challenge'), 'Managed challenge');
});
