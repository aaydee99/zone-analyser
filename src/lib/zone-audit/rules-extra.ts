// More configuration rules for the complete audit: managed rulesets in depth, rules that switch
// security off (IP Access allow rules, configuration rules, page rules, legacy rules, log-only
// rules), bots, rate limiting depth, the remaining zone settings with security impact, and API
// Shield. Pure, same discipline as rules.ts: every condition is the code below, every verdict says
// whether the configuration proves the outcome.
//
// Ruleset IDs (Cloudflare docs, "Managed Rules" overview; full IDs as the rulesets API returns them):
// Cloudflare Managed efb7b8c9…376e9aee, OWASP Core 4814384a…c25d2f1f, Exposed Credentials Check
// (deprecated) c2e18408…14069605, Free Managed 77454fe2…dfb893ba, Sensitive Data Detection
// e22d83c6…499d988e (Enterprise add-on). OWASP tuning (docs, "OWASP concepts" and "configure via
// API"): paranoia level PL1 by default, raised or lowered by disabling the paranoia-level-N
// categories; the score threshold is the score_threshold override of rule 949110
// (6179ae15870a4bb7b2d480d4843b323c): 25 high, 40 medium (default), 60 low sensitivity.

import { OWASP_ANOMALY_RULE, OWASP_RULESET } from '../traffic-types';
import { normAction } from '../waf-fp-score';
import { effectivenessOf } from './effectiveness';
import { isBroad, isBroadPattern, norm, sensitivePaths } from './expr';
import {
  ATTACK, CF_MANAGED, CLIENT, CLOUD, PAID, RES, WEB, active, ap, capped, ev, executes, obj, optRules, phasePath, plural, ruleName, rulesOf, setting, valueOf,
  type Draft, type RuleDef,
} from './rules';
import type { AccessRule, BotConfig, CertPack, LegacyRule, PageRule, RequestData, RulesetRule } from './types';

export const FREE_MANAGED = '77454fe2d30c4220b5701f6fdfb893ba';
export const EXPOSED_CREDENTIALS = 'c2e184081120413c86c3ab7e14069605';
export const SENSITIVE_DATA = 'e22d83c647c64a3eae91b71b499d988e';
export const OWASP_DEFAULT_THRESHOLD = 40;
export const OWASP_LOW_THRESHOLD = 60;
/** Skip exceptions that turn off at least this many managed rules are listed. */
export const MANY_SKIPPED = 10;
/** IP Access rules beyond this many are hard to review. */
export const MANY_ACCESS_RULES = 500;
/** A solved challenge kept for longer than a day lets the same client in without another check. */
export const LONG_CHALLENGE_TTL = 86_400;
/** Rate limit mitigation shorter than this barely slows a brute-force client. */
export const SHORT_MITIGATION = 60;
/** Login-like paths (for leaked credentials detection). */
export const LOGIN_PATH = /\/(login|signin|sign-in|log-in|logon|auth|authenticate|session|sessions|wp-login\.php|user\/login|account\/login|oauth\/token|token)(\/|$|\.|\?)/i;
export const LOGIN_MIN = 100;
/** API-like paths (for API Shield). */
export const API_PATH = /^\/(api|graphql|v\d+|rest|rpc)(\/|$)/i;
export const API_MIN = 1_000, API_SHARE = 0.5;

const managedPath = phasePath('http_request_firewall_managed');
const MANAGED_NAME: Record<string, string> = { [CF_MANAGED]: 'Cloudflare Managed Ruleset', [OWASP_RULESET]: 'OWASP Core Ruleset', [FREE_MANAGED]: 'Cloudflare Free Managed Ruleset', [EXPOSED_CREDENTIALS]: 'Exposed Credentials Check', [SENSITIVE_DATA]: 'Sensitive Data Detection' };
const rsName = (id: unknown) => MANAGED_NAME[String(id)] ?? `managed ruleset ${String(id)}`;
const cats = (n: number) => `${n} ${n === 1 ? 'category' : 'categories'}`;
const list = (v: unknown) => (Array.isArray(v) ? v.map(obj) : []);

// ── Managed rules in depth ──────────────────────────────────────────────────

const MANAGED: RuleDef[] = [
  {
    id: 'managed.cf_overrides', title: 'Cloudflare Managed Ruleset overrides and scope', group: 'managed', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['phase:http_request_firewall_managed', 'zone'], plans: PAID, passed: 'Deployed on all traffic with no rule or category disabled or set to log, and no ruleset-wide action override.',
    check: (c) => {
      const deps = executes(rulesOf(c, 'http_request_firewall_managed'), CF_MANAGED).filter(active);
      if (!deps.length) return { notApplicable: 'The ruleset is not deployed (see waf.managed_ruleset)' };
      const out: Draft[] = [];
      for (const r of deps) {
        const o = obj(ap(r).overrides);
        const name = ruleName(r);
        if (o.action === 'log') out.push({ resource: `${r.id}:action`, verdict: 'confirmed', severity: 'high', title: 'Every Cloudflare Managed Ruleset rule only logs',
          description: 'A ruleset-wide action override of Log makes every rule of the ruleset log its matches and let them through to the origin.', rootCause: 'overrides.action is log on the deploy rule.',
          intendedBehavior: 'The ruleset acts with each rule\'s default action.', evidence: [ev(managedPath, `${name}.action_parameters.overrides.action`, 'log')],
          fix: ['Security › WAF › Managed rules › Cloudflare Managed Ruleset › Configure: set Ruleset action to Default.'] });
        else if (typeof o.action === 'string') out.push({ resource: `${r.id}:action`, verdict: 'confirmed', severity: 'info', title: `Every Cloudflare Managed Ruleset rule uses the action ${o.action}`,
          description: 'A ruleset-wide action override replaces each rule\'s default action.', rootCause: `overrides.action is ${o.action}.`, intendedBehavior: 'Each rule\'s default action unless there is a reason.',
          evidence: [ev(managedPath, `${name}.action_parameters.overrides.action`, o.action)], fix: ['Keep it if intended; otherwise set Ruleset action to Default.'] });
        const weakRules = list(o.rules).filter((x) => x.enabled === false || x.action === 'log');
        const weakCats = list(o.categories).filter((x) => x.enabled === false || x.action === 'log');
        if (weakRules.length || weakCats.length) out.push({ resource: `${r.id}:overrides`, verdict: 'confirmed', severity: 'medium',
          title: `${[weakRules.length ? plural(weakRules.length, 'rule') : '', weakCats.length ? cats(weakCats.length) : ''].filter(Boolean).join(' and ')} of the Cloudflare Managed Ruleset ${weakRules.length + weakCats.length === 1 ? 'is' : 'are'} off or only log${weakRules.length + weakCats.length === 1 ? 's' : ''}`,
          description: `Matches of these rules reach the origin: ${[...weakCats.map((x) => `category ${String(x.category)} (${x.enabled === false ? 'disabled' : 'log'})`), ...weakRules.slice(0, 10).map((x) => `rule ${String(x.id)} (${x.enabled === false ? 'disabled' : 'log'})`)].join(', ')}${weakRules.length > 10 ? ', …' : ''}.`,
          rootCause: 'Rule or category overrides on the deploy rule.', intendedBehavior: 'Overrides only for rules proven to cause false positives, preferably as narrow exceptions instead.',
          evidence: [ev(managedPath, `${name}.overrides.categories (off or log)`, weakCats.map((x) => String(x.category)).join(', ') || '(none)'), ev(managedPath, `${name}.overrides.rules (off or log)`, weakRules.map((x) => String(x.id)).join(', ') || '(none)')],
          fix: ['Security › WAF › Managed rules › Cloudflare Managed Ruleset › Configure › Browse rules: re-enable them, and handle false positives with an exception limited to the affected path.'] });
        if (!isBroad(r.expression)) out.push({ resource: `${r.id}:scope`, verdict: 'needs_validation', severity: 'medium', title: 'The Cloudflare Managed Ruleset runs on part of the traffic only',
          description: `The deploy rule matches \`${norm(r.expression)}\`: requests outside it are not inspected.`, rootCause: 'The deploy rule has a narrowing expression.', intendedBehavior: 'The ruleset runs on every proxied hostname.',
          evidence: [ev(managedPath, `${name}.expression`, r.expression ?? '')], fix: ['Security › WAF › Managed rules › Cloudflare Managed Ruleset › Edit scope: All incoming requests.'],
          validation: 'List the proxied hostnames (DNS › Records) and check which fall outside the expression; any that serve an application are unprotected.' });
      }
      return out;
    },
  },
  {
    id: 'managed.owasp_tuning', title: 'OWASP Core Ruleset paranoia level and threshold', group: 'managed', attackClass: 'Injection', skillRef: ATTACK,
    needs: ['phase:http_request_firewall_managed', 'zone'], plans: PAID, passed: 'OWASP runs at the default threshold (40) or stricter, with no attack categories disabled.',
    check: (c) => {
      const deps = executes(rulesOf(c, 'http_request_firewall_managed'), OWASP_RULESET).filter(active);
      if (!deps.length) return { notApplicable: 'The OWASP Core Ruleset is not deployed (see waf.owasp)' };
      const out: Draft[] = [];
      for (const r of deps) {
        const o = obj(ap(r).overrides);
        const anomaly = list(o.rules).find((x) => String(x.id) === OWASP_ANOMALY_RULE);
        const threshold = Number(anomaly?.score_threshold ?? OWASP_DEFAULT_THRESHOLD);
        const cats = list(o.categories);
        const plOff = cats.filter((x) => /^paranoia-level-\d$/.test(String(x.category)) && x.enabled === false).map((x) => Number(String(x.category).slice(-1)));
        const pl = plOff.length ? Math.min(...plOff) - 1 : null;
        const otherOff = cats.filter((x) => !/^paranoia-level-\d$/.test(String(x.category)) && (x.enabled === false || x.action === 'log'));
        const e = [ev(managedPath, `${ruleName(r)}.overrides.rules[949110].score_threshold`, anomaly?.score_threshold ?? `(not set: ${OWASP_DEFAULT_THRESHOLD})`), ev(managedPath, 'paranoia level', pl === null ? '(not set: PL1 by default)' : `PL${pl}`)];
        if (threshold >= OWASP_LOW_THRESHOLD) out.push({ resource: `${r.id}:threshold`, verdict: 'confirmed', severity: (pl ?? 1) <= 1 ? 'medium' : 'low',
          title: `OWASP needs an anomaly score of ${threshold} to act${(pl ?? 1) <= 1 ? ' at paranoia level 1 — its weakest setting' : ''}`,
          description: 'Low sensitivity (60) lets requests that match several attack signatures through; at PL1 the fewest signatures are checked.', rootCause: `score_threshold ${threshold} on rule 949110${pl === null ? '' : `, paranoia level ${pl}`}.`,
          intendedBehavior: 'Medium (40) or High (25) sensitivity, and PL2 where the application tolerates it.', evidence: e,
          fix: ['Security › WAF › Managed rules › OWASP Core Ruleset › Configure: set the score threshold to Medium (40); review the logs before moving to PL2.'] });
        if (otherOff.length) out.push({ resource: `${r.id}:categories`, verdict: 'confirmed', severity: 'low', title: `${otherOff.length} OWASP ${otherOff.length === 1 ? 'category' : 'categories'} disabled or set to log`,
          description: `Attack types not scored: ${otherOff.map((x) => String(x.category)).join(', ')}.`, rootCause: 'Category overrides on the OWASP deploy rule.', intendedBehavior: 'All attack categories score.',
          evidence: [ev(managedPath, `${ruleName(r)}.overrides.categories`, otherOff.map((x) => `${String(x.category)}: ${x.enabled === false ? 'disabled' : 'log'}`).join(', '))], fix: ['Security › WAF › Managed rules › OWASP Core Ruleset › Browse rules: re-enable the categories.'] });
        if (anomaly && typeof anomaly.action === 'string' && anomaly.action !== 'block' && anomaly.action !== 'log') out.push({ resource: `${r.id}:action`, verdict: 'confirmed', severity: 'info', title: `OWASP challenges (${anomaly.action}) instead of blocking`,
          description: 'Requests over the threshold get a challenge; automated attack tools fail it, but a person can pass.', rootCause: 'Action override on rule 949110.', intendedBehavior: 'Block, unless challenges are wanted on purpose.',
          evidence: [ev(managedPath, `${ruleName(r)}.overrides.rules[949110].action`, anomaly.action)], fix: ['Keep it if intended.'] });
      }
      return out;
    },
  },
  {
    id: 'managed.free_ruleset', title: 'Cloudflare Free Managed Ruleset', group: 'managed', attackClass: 'Injection', skillRef: ATTACK,
    needs: ['phase:http_request_firewall_managed', 'zone'], plans: ['free'], passed: 'The Free Managed Ruleset is deployed and enabled.',
    check: (c) => {
      const deps = executes(rulesOf(c, 'http_request_firewall_managed'), FREE_MANAGED);
      if (deps.some(active)) return [];
      const e = [ev(managedPath, 'Free Managed Ruleset deploy rule', deps.length ? 'disabled' : '(none)')];
      return [deps.length
        ? { verdict: 'confirmed', severity: 'medium', title: 'The Free Managed Ruleset is deployed but disabled', description: 'On the Free plan it is the only managed protection against high-impact, widely exploited vulnerabilities.', rootCause: 'Its deploy rule is disabled.', intendedBehavior: 'Enabled.', evidence: e, fix: ['Security › WAF › Managed rules: enable the Cloudflare Free Managed Ruleset.'] }
        : { verdict: 'needs_validation', severity: 'medium', title: 'The Free Managed Ruleset is not in the managed rules phase', description: 'Cloudflare deploys it on Free zones by default; it may run without an entrypoint rule, or it may have been removed.', rootCause: 'No rule executes ruleset 77454fe2d30c4220b5701f6fdfb893ba.', intendedBehavior: 'Deployed.', evidence: e, fix: ['Security › WAF › Managed rules: check that the Cloudflare Free Managed Ruleset shows as enabled; deploy it if not.'], validation: 'Open Security › WAF › Managed rules in the dashboard: "Enabled" next to the Free Managed Ruleset settles it.' }];
    },
  },
  {
    id: 'managed.leaked_credentials', title: 'Leaked credentials detection', group: 'managed', attackClass: 'Password reset and broader recovery', skillRef: WEB,
    needs: ['leaked_credentials'], passed: 'Leaked credentials detection is on.',
    check: (c) => {
      if (c.v<{ enabled?: boolean }>('leaked_credentials')?.enabled) return [];
      const ecc = executes(optRules(c, 'http_request_firewall_managed') ?? [], EXPOSED_CREDENTIALS).some(active);
      if (ecc) return [];
      const req = c.opt<RequestData>('requests');
      const logins = req ? req.paths.filter((p) => LOGIN_PATH.test(p.path)).reduce((a, p) => a + p.count, 0) : null;
      const busy = logins !== null && logins >= LOGIN_MIN;
      return [{ verdict: 'needs_validation', severity: busy ? 'medium' : 'info', title: `Leaked credentials detection is off${busy ? ` while login paths got ${logins} requests` : ''}`,
        description: 'Logins with username/password pairs known from breaches are not flagged, so credential-stuffing attempts look like ordinary logins to your rules.',
        rootCause: 'Leaked credentials detection is disabled and the (deprecated) Exposed Credentials Check is not deployed.', intendedBehavior: 'Detection on, and a rule that challenges or blocks leaked-credential logins.',
        evidence: [ev('GET /zones/{id}/leaked-credential-checks', 'enabled', false), ev('GraphQL httpRequestsAdaptiveGroups', 'requests to login-like paths', logins ?? '(not read)')],
        fix: ['Security › Settings › Detections: turn on Leaked credentials detection.', 'Then add a custom rule: `(cf.waf.credential_check.username_and_password_leaked)` with action Managed Challenge on your login paths.'],
        validation: 'Check whether the zone has a login form or a login API; if it has none, this does not apply.' }];
    },
  },
  {
    id: 'managed.sensitive_data', title: 'Sensitive Data Detection (responses)', group: 'managed', attackClass: 'Feature abuse and data leakage', skillRef: ATTACK,
    needs: ['phase:http_response_firewall_managed', 'zone'], plans: ['enterprise'], passed: 'Sensitive Data Detection runs on responses.',
    check: (c) => executes(rulesOf(c, 'http_response_firewall_managed'), SENSITIVE_DATA).some(active) ? [] : [{ verdict: 'needs_validation', severity: 'info', title: 'Sensitive Data Detection does not run on responses',
      description: 'Responses that leak card numbers, national IDs or keys are not flagged.', rootCause: 'No rule in http_response_firewall_managed executes ruleset e22d83c647c64a3eae91b71b499d988e.',
      intendedBehavior: 'Deployed in Log mode at least, where the subscription includes it.', evidence: [ev(phasePath('http_response_firewall_managed'), 'Sensitive Data Detection deploy rule', '(none)')],
      fix: ['Security › WAF › Managed rules: deploy Cloudflare Sensitive Data Detection (Log).'], validation: 'It is an add-on: check the zone\'s Enterprise subscription for it before planning the change.' }],
  },
  {
    id: 'managed.exceptions', title: 'Managed-rule exceptions (skip rules)', group: 'managed', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['phase:http_request_firewall_managed'], passed: 'No managed-rule exception is broad, skips whole rulesets or many rules, or sits where it has no effect.',
    check: (c) => {
      const rules = rulesOf(c, 'http_request_firewall_managed');
      const lastExec = rules.reduce((a, r, i) => (r.action === 'execute' && active(r) ? i : a), -1);
      const out: Draft[] = [];
      rules.forEach((r, i) => {
        if (r.action !== 'skip' || !active(r)) return;
        const p = ap(r);
        const sets = Array.isArray(p.rulesets) ? p.rulesets.map(String) : p.ruleset === 'current' ? ['all remaining managed rules'] : [];
        const skippedRules = Object.values(obj(p.rules)).reduce((a: number, v) => a + (Array.isArray(v) ? v.length : 0), 0);
        // The exception's traffic in the window (its skips are logged as events of the managed phase).
        const row = effectivenessOf(c.s)?.eff.rules.find((x) => x.ruleId === r.id && x.kind === 'managed');
        const skipped = row ? Object.entries(row.byAction).filter(([act]) => normAction(act) === 'skip').reduce((t, [, v]) => t + v, 0) : null;
        const e = [ev(managedPath, `${ruleName(r)}.expression`, r.expression ?? ''), ev(managedPath, `${ruleName(r)}.action_parameters`, p),
          ...(c.s.reads.events?.state === 'ok' ? [ev('GraphQL firewallEventsAdaptiveGroups', 'requests it skipped in the window (see Effectiveness)', `${skipped ?? 0}${row?.passthrough ? ` — ${row.passthrough.verdict}` : ''}`)] : [])];
        const what = sets.length ? sets.map(rsName).join(', ') : `${skippedRules} managed rules`;
        if (i > lastExec) out.push({ resource: `${r.id ?? i}:order`, verdict: 'confirmed', severity: 'info', title: `Exception “${ruleName(r)}” comes after every deploy rule and has no effect`,
          description: 'Rules run in order: an exception only skips managed rules deployed after it.', rootCause: 'The skip rule is placed below the deploy rules.', intendedBehavior: 'Exceptions sit above the deploy rule they apply to.', evidence: e,
          fix: ['Security › WAF › Managed rules: drag the exception above the ruleset it should skip — or delete it if it is not needed (it does nothing now).'] });
        else if (isBroad(r.expression)) out.push({ resource: `${r.id ?? i}:broad`, verdict: 'confirmed', severity: 'high', title: `Exception “${ruleName(r)}” skips ${what} for every request`,
          description: `Its expression \`${norm(r.expression)}\` matches the whole zone or whole hostnames, so those managed rules never run there.`, rootCause: 'A managed-rule exception without a narrowing condition.', intendedBehavior: 'Exceptions limited to the path (and client) that triggered a false positive.', evidence: e,
          fix: [`Security › WAF › Managed rules › exception “${ruleName(r)}”: add the path and client it is for, e.g. \`and http.request.uri.path eq "/api/upload"\`.`] });
        else if (sets.length) out.push({ resource: `${r.id ?? i}:rulesets`, verdict: 'confirmed', severity: 'medium', title: `Exception “${ruleName(r)}” skips whole rulesets (${what})`,
          description: 'Everything the expression matches gets no managed-rule inspection at all.', rootCause: 'The exception skips rulesets instead of individual rules.', intendedBehavior: 'Skip only the specific rules that cause the false positive.', evidence: e,
          fix: [`Edit the exception to skip only the specific rule IDs that cause false positives (Security › Events shows which ones match).`] });
        else if (skippedRules >= MANY_SKIPPED) out.push({ resource: `${r.id ?? i}:many`, verdict: 'confirmed', severity: 'low', title: `Exception “${ruleName(r)}” skips ${skippedRules} managed rules`,
          description: 'A long skip list is hard to review and tends to grow.', rootCause: `The exception lists ${skippedRules} rules.`, intendedBehavior: 'A few rules, each with a known false positive.', evidence: e,
          fix: ['Review which skipped rules still match legitimate traffic (Security › Events) and drop the rest from the list.'] });
      });
      return out;
    },
  },
  {
    id: 'managed.all_disabled', title: 'Managed rulesets whose deploy rules are all disabled', group: 'managed', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['phase:http_request_firewall_managed'], passed: 'Every deployed managed ruleset has an enabled deploy rule.',
    check: (c) => {
      const by = new Map<string, RulesetRule[]>();
      for (const r of rulesOf(c, 'http_request_firewall_managed')) if (r.action === 'execute') by.set(String(ap(r).id), [...(by.get(String(ap(r).id)) ?? []), r]);
      // The Cloudflare Managed and OWASP rulesets have rules of their own (waf.managed_ruleset, waf.owasp).
      return [...by].filter(([id, rs]) => id !== CF_MANAGED && id !== OWASP_RULESET && !rs.some(active)).map(([id, rs]) => ({
        resource: id, verdict: 'confirmed' as const, severity: 'medium' as const, title: `${rsName(id)} is deployed but every deploy rule is disabled`,
        description: 'It looks configured in the dashboard but inspects nothing.', rootCause: `${plural(rs.length, 'deploy rule')}, all disabled.`, intendedBehavior: 'Enabled, or removed if not wanted.',
        evidence: rs.map((r) => ev(managedPath, ruleName(r), 'enabled: false')), fix: [`Security › WAF › Managed rules: enable ${rsName(id)}, or delete its deploy rule.`],
      }));
    },
  },
];

// ── Rules that switch security off ──────────────────────────────────────────

/** An allow-listed IP Access target that covers many clients: a country, an ASN, or a range of /16 (IPv4) or /48 (IPv6) and wider. */
function broadTarget(r: AccessRule): string | null {
  const t = r.configuration?.target, v = r.configuration?.value ?? '';
  if (t === 'country') return `country ${v}`;
  if (t === 'asn') return `network ${v}`;
  if (t === 'ip_range') { const bits = Number(v.split('/')[1]); if (v.includes(':') ? bits <= 48 : bits <= 16) return `range ${v}`; }
  return null;
}
const accessRules = (label: string, path: string, key: 'access_rules' | 'account_access_rules', id: string, permissionNote: string): RuleDef => ({
  id, title: `IP Access allow rules (${label})`, group: 'bypass', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
  needs: [key], passed: `No ${label} IP Access rule allow-lists a country, network or wide range.`,
  check: (c) => {
    const rules = c.v<AccessRule[]>(key) ?? [];
    const allow = rules.filter((r) => r.mode === 'whitelist' && !r.paused);
    const broad = allow.map((r) => ({ r, what: broadTarget(r) })).filter((x): x is { r: AccessRule; what: string } => !!x.what);
    const out: Draft[] = capped(broad.map(({ r, what }) => ({ resource: r.id, verdict: 'confirmed', severity: 'high', title: `An IP Access rule allows all of ${what}${permissionNote}`,
      description: 'Allow rules skip the WAF (custom and managed rules), rate limiting, Bot Fight Mode and the security level for every request they match — here a large share of the internet.',
      rootCause: 'An IP Access rule in Allow mode for a broad target.', intendedBehavior: 'Allow rules only for specific trusted addresses; exceptions for broad groups as narrow custom skip rules.',
      evidence: [ev(path, `${r.id}.configuration`, `${r.configuration?.target} ${r.configuration?.value}`), ev(path, `${r.id}.mode`, 'whitelist'), ev(path, `${r.id}.notes`, r.notes ?? '')],
      fix: [`Security › WAF › Tools › IP Access Rules: delete the allow rule for ${what}; if some traffic from it must bypass a product, add a custom rule with action Skip for that product and a narrow expression (path, and an IP list).`] } as Draft)),
    (n) => ({ resource: 'more', verdict: 'confirmed', severity: 'high', title: `${n} more broad IP Access allow rules`, description: 'Listed in the CSV of IP Access rules.', rootCause: 'As above.', intendedBehavior: 'As above.', evidence: [ev(path, 'rules not listed', n)], fix: ['Review them in Security › WAF › Tools.'] }));
    if (rules.length >= MANY_ACCESS_RULES) out.push({ resource: 'count', verdict: 'confirmed', severity: 'info', title: `${rules.length}+ IP Access rules${permissionNote}`, description: 'A list this long is rarely reviewed; stale allow entries tend to stay.', rootCause: 'Rules accumulate.', intendedBehavior: 'A short, documented list, or IP Lists used in custom rules.', evidence: [ev(path, 'rules', rules.length), ev(path, 'allow rules', allow.length)], fix: ['Export and review the list; move groups of addresses into an IP List used by a custom rule.'] });
    return out;
  },
});

const PR_PATH = 'GET /zones/{id}/pagerules';
const BYPASS: RuleDef[] = [
  accessRules('zone', 'GET /zones/{id}/firewall/access_rules/rules', 'access_rules', 'bypass.ip_access_allow', ''),
  accessRules('account', 'GET /accounts/{account}/firewall/access_rules/rules', 'account_access_rules', 'bypass.account_ip_access_allow', ' (account-wide: every zone of the account)'),
  {
    id: 'bypass.config_rules', title: 'Configuration rules that turn security off', group: 'bypass', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['phase:http_config_settings'], passed: 'No configuration rule lowers the security level, turns off the browser integrity check or weakens SSL.',
    check: (c) => rulesOf(c, 'http_config_settings').filter((r) => active(r) && r.action === 'set_config').flatMap((r): Draft[] => {
      const p = ap(r);
      const hits: { what: string; sev: 'high' | 'medium' | 'low' }[] = [];
      if (p.security_level === 'off' || p.security_level === 'essentially_off') hits.push({ what: `security level ${p.security_level}`, sev: 'high' });
      if (p.ssl === 'off' || p.ssl === 'flexible') hits.push({ what: `SSL ${p.ssl}`, sev: 'high' });
      if (p.bic === false) hits.push({ what: 'browser integrity check off', sev: 'medium' });
      if (p.automatic_https_rewrites === false) hits.push({ what: 'HTTPS rewrites off', sev: 'low' });
      if (!hits.length) return [];
      const sev = hits.some((h) => h.sev === 'high') ? 'high' : hits.some((h) => h.sev === 'medium') ? 'medium' : 'low';
      const sens = sensitivePaths(r.expression);
      return [{ resource: r.id ?? ruleName(r), verdict: 'confirmed', severity: sev, title: `Configuration rule “${ruleName(r)}” sets ${hits.map((h) => h.what).join(', ')}${sens.length ? ` on ${sens.join(', ')}` : isBroad(r.expression) ? ' for every request' : ''}`,
        description: 'Configuration rules override the zone settings for the requests they match; this one weakens protection there.', rootCause: 'A set_config action with weaker security values.',
        intendedBehavior: 'Zone-level security applies everywhere, with narrow exceptions only.', evidence: [ev(phasePath('http_config_settings'), `${ruleName(r)}.expression`, r.expression ?? ''), ev(phasePath('http_config_settings'), `${ruleName(r)}.action_parameters`, p)],
        fix: [`Rules › Configuration Rules › “${ruleName(r)}”: remove those settings, or narrow the expression to the exact paths that need them.`] }];
    }),
  },
  {
    id: 'bypass.page_rules', title: 'Page rules that turn security off', group: 'bypass', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['page_rules'], passed: 'No active page rule lowers the security level, disables security features or weakens SSL.',
    check: (c) => (c.v<PageRule[]>('page_rules') ?? []).filter((p) => !p.status || p.status === 'active').flatMap((p): Draft[] => {
      const a = new Map((p.actions ?? []).map((x) => [x.id, x.value]));
      const hits: { what: string; sev: 'high' | 'medium' | 'low' }[] = [];
      if (a.has('disable_security')) hits.push({ what: 'Disable Security', sev: 'high' });
      if (a.get('security_level') === 'off' || a.get('security_level') === 'essentially_off') hits.push({ what: `security level ${a.get('security_level')}`, sev: 'high' });
      if (a.get('ssl') === 'off' || a.get('ssl') === 'flexible') hits.push({ what: `SSL ${a.get('ssl')}`, sev: 'high' });
      if (a.get('browser_check') === 'off') hits.push({ what: 'browser integrity check off', sev: 'medium' });
      if (a.get('waf') === 'off') hits.push({ what: 'WAF (previous version) off', sev: 'medium' });
      if (a.get('automatic_https_rewrites') === 'off') hits.push({ what: 'HTTPS rewrites off', sev: 'low' });
      if (!hits.length) return [];
      const url = p.targets?.[0]?.constraint?.value ?? '';
      const sev = hits.some((h) => h.sev === 'high') ? 'high' : hits.some((h) => h.sev === 'medium') ? 'medium' : 'low';
      return [{ resource: p.id, verdict: 'confirmed', severity: sev, title: `Page rule ${url} sets ${hits.map((h) => h.what).join(', ')}${isBroadPattern(url) ? ' for the whole host' : ''}`,
        description: 'Page rules override zone settings for matching URLs; this one weakens protection there.', rootCause: 'Page rule actions with weaker security values.', intendedBehavior: 'No security weakened by page rules (they are deprecated; configuration rules replace them).',
        evidence: [ev(PR_PATH, `${p.id}.target`, url), ev(PR_PATH, `${p.id}.actions`, p.actions ?? [])], fix: [`Rules › Page Rules: remove those settings from the rule for ${url}, or delete the rule.`] }];
    }),
  },
  {
    id: 'bypass.lockdowns', title: 'Zone Lockdown rules (legacy)', group: 'bypass', attackClass: 'Unexpected service or management-plane reachability', skillRef: CLOUD,
    needs: ['lockdowns'], passed: 'No paused Zone Lockdown rule.',
    check: (c) => {
      const paused = (c.v<LegacyRule[]>('lockdowns') ?? []).filter((r) => r.paused);
      return paused.length ? [{ verdict: 'confirmed', severity: 'low', title: `${plural(paused.length, 'Zone Lockdown rule')} paused`, description: 'A paused lockdown no longer limits its URLs to the allowed addresses: they are open to everyone.',
        rootCause: 'Paused legacy rules.', intendedBehavior: 'Active, or replaced by a custom rule (Zone Lockdown is a legacy product).', evidence: paused.slice(0, 10).map((r) => ev('GET /zones/{id}/firewall/lockdowns', r.description || r.id, (r.urls ?? []).join(', '))),
        fix: ['Security › WAF › Tools › Zone Lockdown: resume or delete each rule; better, recreate it as a custom rule `(http.request.uri.path in {…} and not ip.src in $allowed)` → Block.'] }] : [];
    },
  },
  {
    id: 'bypass.ua_rules', title: 'User Agent Blocking rules (legacy)', group: 'bypass', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['ua_rules'], passed: 'No paused User Agent Blocking rule.',
    check: (c) => {
      const paused = (c.v<LegacyRule[]>('ua_rules') ?? []).filter((r) => r.paused);
      return paused.length ? [{ verdict: 'confirmed', severity: 'info', title: `${plural(paused.length, 'User Agent Blocking rule')} paused`, description: 'Listed so they are a decision: paused rules block nothing.', rootCause: 'Paused legacy rules.', intendedBehavior: 'Active or deleted.',
        evidence: paused.slice(0, 10).map((r) => ev('GET /zones/{id}/firewall/ua_rules', r.description || r.id, r.mode ?? '')), fix: ['Security › WAF › Tools › User Agent Blocking: resume or delete them.'] }] : [];
    },
  },
  {
    id: 'waf.custom_log_only', title: 'Custom rules that only log', group: 'waf', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['phase:http_request_firewall_custom'], passed: 'No enabled custom rule uses the Log action.',
    check: (c) => {
      const logs = rulesOf(c, 'http_request_firewall_custom').filter((r) => active(r) && r.action === 'log');
      return logs.length ? [{ verdict: 'confirmed', severity: 'info', title: `${plural(logs.length, 'custom rule')} only log`, description: 'They record matches and let them through. The traffic section says what they let through.',
        rootCause: 'Action Log.', intendedBehavior: 'Log while testing a rule, then an action.', evidence: logs.slice(0, 20).map((r) => ev(phasePath('http_request_firewall_custom'), ruleName(r), r.expression ?? '')),
        fix: ['Security › WAF › Custom rules: once the logs confirm what each rule matches, change Log to Managed Challenge or Block.'] }] : [];
    },
  },
];

// ── Bots ────────────────────────────────────────────────────────────────────

const BOT = 'GET /zones/{id}/bot_management';
/** Bot Management (Enterprise add-on) answers without the Bot Fight Mode and Super Bot Fight Mode fields. */
const isBotManagement = (b: BotConfig) => b.fight_mode === undefined && b.sbfm_definitely_automated === undefined && (b.using_latest_model !== undefined || b.auto_update_model !== undefined);

const BOTS: RuleDef[] = [
  {
    id: 'bots.sbfm_config', title: 'Super Bot Fight Mode settings', group: 'bots', attackClass: 'Pre-authentication work imbalance', skillRef: RES,
    needs: ['bot', 'zone'], plans: ['pro', 'business'], passed: 'Likely automated traffic is acted on, JavaScript detections are on, verified bots are allowed.',
    check: (c) => {
      const b = c.v<BotConfig>('bot') ?? {};
      const out: Draft[] = [];
      if (c.zone?.plan === 'business' && (b.sbfm_likely_automated ?? 'allow') === 'allow') out.push({ resource: 'likely', verdict: 'confirmed', severity: 'low', title: 'Likely automated traffic is allowed', description: 'Requests Cloudflare scores as likely automated reach the origin unchallenged.', rootCause: 'sbfm_likely_automated is allow.', intendedBehavior: 'Managed Challenge.', evidence: [ev(BOT, 'sbfm_likely_automated', b.sbfm_likely_automated ?? '(not set)')], fix: ['Security › Bots › Configure Super Bot Fight Mode: Likely automated → Managed Challenge.'] });
      if (b.enable_js === false) out.push({ resource: 'js', verdict: 'confirmed', severity: 'low', title: 'JavaScript detections are off', description: 'Headless browsers that pass other checks are not detected.', rootCause: 'enable_js is false.', intendedBehavior: 'On.', evidence: [ev(BOT, 'enable_js', false)], fix: ['Security › Bots › Configure: turn on JavaScript detections.'] });
      if (b.sbfm_verified_bots === 'block') out.push({ resource: 'verified', verdict: 'confirmed', severity: 'info', title: 'Verified bots (search engines, monitors) are blocked', description: 'Good bots cannot index or monitor the site.', rootCause: 'sbfm_verified_bots is block.', intendedBehavior: 'Allow, unless intended.', evidence: [ev(BOT, 'sbfm_verified_bots', 'block')], fix: ['Security › Bots › Configure: Verified bots → Allow.'] });
      if (b.sbfm_static_resource_protection === false) out.push({ resource: 'static', verdict: 'confirmed', severity: 'info', title: 'Static resources are not protected from bots', description: 'Bots can fetch images, scripts and files freely (scraping, hotlinking).', rootCause: 'sbfm_static_resource_protection is false.', intendedBehavior: 'A choice, often fine.', evidence: [ev(BOT, 'sbfm_static_resource_protection', false)], fix: ['Turn on Static resource protection if bots scraping assets is a concern.'] });
      return out;
    },
  },
  {
    id: 'bots.bm_rules', title: 'Bot Management scores used in rules', group: 'bots', attackClass: 'Pre-authentication work imbalance', skillRef: RES,
    needs: ['bot', 'zone', 'phase:http_request_firewall_custom', 'phase:http_ratelimit'], plans: ['enterprise'], passed: 'Custom or rate limiting rules act on the bot score below 30.',
    check: (c) => {
      const b = c.v<BotConfig>('bot') ?? {};
      if (!isBotManagement(b)) return { notApplicable: 'Bot Management is not on this zone (no scores to use)' };
      const rules = [...rulesOf(c, 'http_request_firewall_custom'), ...rulesOf(c, 'http_ratelimit')].filter((r) => active(r) && /cf\.bot_management\.score/.test(r.expression ?? ''));
      if (!rules.length) return [{ verdict: 'needs_validation', severity: 'medium', title: 'No rule uses the bot score', description: 'Bot Management scores every request, but no custom or rate limiting rule acts on the score, so automated traffic is only measured.',
        rootCause: 'No expression references cf.bot_management.score.', intendedBehavior: 'A rule such as `(cf.bot_management.score lt 30 and not cf.bot_management.verified_bot)` → Managed Challenge on sensitive paths.',
        evidence: [ev(phasePath('http_request_firewall_custom'), 'rules using cf.bot_management.score', 0)], fix: ['Security › WAF › Custom rules › Create: `(cf.bot_management.score lt 30 and not cf.bot_management.verified_bot and not cf.bot_management.static_resource)` → Managed Challenge.'],
        validation: 'Check Security › Bots analytics for the share of likely automated traffic; if it is meaningful, add the rule.' }];
      const weak = rules.filter((r) => { const m = /cf\.bot_management\.score (?:lt|<) (\d+)/.exec(r.expression ?? ''); return m && Number(m[1]) <= 2; });
      return weak.map((r) => ({ resource: r.id ?? ruleName(r), verdict: 'needs_validation' as const, severity: 'low' as const, title: `“${ruleName(r)}” only acts on bot score 1`,
        description: 'Scores 2–29 are likely automated too; a threshold of 2 lets them through.', rootCause: 'A very low score threshold.', intendedBehavior: 'Threshold 30 (with a challenge) unless false positives were seen.',
        evidence: [ev(phasePath('http_request_firewall_custom'), `${ruleName(r)}.expression`, r.expression ?? '')], fix: [`Raise the threshold in “${ruleName(r)}” to 30, with Managed Challenge.`],
        validation: 'Compare challenge solve rates at score 2–29 in Security › Bots: low solve rates confirm they are bots.' }));
    },
  },
  {
    id: 'bots.ai_bots', title: 'AI crawler blocking', group: 'bots', attackClass: 'Feature abuse and data leakage', skillRef: ATTACK,
    needs: ['bot'], passed: 'AI scrapers and crawlers are blocked (or the setting is not offered).',
    check: (c) => c.v<BotConfig>('bot')?.ai_bots_protection !== 'disabled' ? [] : [{ verdict: 'confirmed', severity: 'info', title: 'AI scrapers and crawlers are not blocked', description: 'Content can be collected for model training without asking.',
      rootCause: 'ai_bots_protection is disabled.', intendedBehavior: 'A decision: block, or allow on purpose.', evidence: [ev(BOT, 'ai_bots_protection', 'disabled')], fix: ['Security › Bots: turn on Block AI bots if the content should not be used for training.'] }],
  },
];

// ── Rate limiting depth ─────────────────────────────────────────────────────

const RL_PATH = phasePath('http_ratelimit');
const RATE: RuleDef[] = [
  {
    id: 'avail.ratelimit_depth', title: 'Rate limiting rule settings', group: 'availability', attackClass: 'Quota-accounting scope and reset gaps', skillRef: RES,
    needs: ['phase:http_ratelimit'], passed: 'Rate limits count by more than the client IP or have a reason to, mitigate for at least a minute, and none is disabled.',
    check: (c) => {
      const out: Draft[] = [];
      for (const r of rulesOf(c, 'http_ratelimit')) {
        const rl = r.ratelimit ?? {};
        const ch = (rl.characteristics ?? []).filter((x) => x !== 'cf.colo.id');
        if (r.enabled === false) { out.push({ resource: `${r.id}:off`, verdict: 'confirmed', severity: 'info', title: `Rate limit “${ruleName(r)}” is disabled`, description: 'It limits nothing.', rootCause: 'enabled: false.', intendedBehavior: 'On or deleted.', evidence: [ev(RL_PATH, ruleName(r), 'enabled: false')], fix: ['Security › WAF › Rate limiting rules: enable or delete it.'] }); continue; }
        if (r.action === 'log') out.push({ resource: `${r.id}:log`, verdict: 'confirmed', severity: 'medium', title: `Rate limit “${ruleName(r)}” only logs`, description: 'Clients over the threshold are recorded and keep going.', rootCause: 'Action Log.', intendedBehavior: 'Block or Managed Challenge once the threshold is validated.', evidence: [ev(RL_PATH, `${ruleName(r)}.action`, 'log')], fix: [`Security › WAF › Rate limiting rules › “${ruleName(r)}”: set the action to Block (or Managed Challenge).`] });
        if (ch.length === 1 && ch[0] === 'ip.src') out.push({ resource: `${r.id}:ip`, verdict: 'needs_validation', severity: 'low', title: `Rate limit “${ruleName(r)}” counts per IP address only`,
          description: 'Clients behind one NAT, proxy or mobile carrier share a counter (false positives), while an attacker spreading over many addresses never reaches it.', rootCause: 'characteristics: ip.src.',
          intendedBehavior: 'Count by IP plus a session or API key header/cookie where the application has one.', evidence: [ev(RL_PATH, `${ruleName(r)}.ratelimit.characteristics`, rl.characteristics ?? [])],
          fix: [`Add a characteristic such as \`http.request.headers["authorization"]\` or a session cookie to “${ruleName(r)}” (Enterprise with Advanced Rate Limiting), or accept the trade-off.`],
          validation: 'Check whether most of the protected traffic comes from a few shared addresses (corporate proxies, carriers) in Security › Analytics.' });
        if (r.action === 'block' && typeof rl.mitigation_timeout === 'number' && rl.mitigation_timeout < SHORT_MITIGATION) out.push({ resource: `${r.id}:timeout`, verdict: 'confirmed', severity: 'low',
          title: `Rate limit “${ruleName(r)}” blocks for only ${rl.mitigation_timeout} seconds`, description: 'A brute-force client pauses briefly and continues at almost the same rate.', rootCause: `mitigation_timeout ${rl.mitigation_timeout}.`,
          intendedBehavior: 'At least 60 seconds (10 minutes on login paths).', evidence: [ev(RL_PATH, `${ruleName(r)}.ratelimit.mitigation_timeout`, rl.mitigation_timeout)], fix: [`Raise the mitigation timeout of “${ruleName(r)}” to 600 seconds (where the plan allows).`] });
      }
      return out;
    },
  },
];

// ── Remaining zone settings with security impact ────────────────────────────

/** One setting, one rule: `bad(value)` returns the finding or null. */
const settingRule = (o: { id: string; setting: string; title: string; group: RuleDef['group']; attackClass: string; skillRef: string; passed: string; bad: (v: unknown) => Omit<Draft, 'evidence'> | null }): RuleDef => ({
  id: o.id, title: o.title, group: o.group, attackClass: o.attackClass, skillRef: o.skillRef, needs: [`setting:${o.setting}` as const] as RuleDef['needs'], passed: o.passed,
  check: (c) => { const v = valueOf<unknown>(c, o.setting); const d = o.bad(v); return d ? [{ ...d, evidence: [ev(setting(o.setting), 'value', v)] }] : []; },
});

const SETTINGS: RuleDef[] = [
  settingRule({ id: 'tls.0rtt', setting: '0rtt', title: '0-RTT connection resumption', group: 'transport', attackClass: 'Request framing and desynchronization', skillRef: WEB, passed: '0-RTT is off.',
    bad: (v) => v === 'on' ? { verdict: 'needs_validation', severity: 'low', title: '0-RTT is on: early data can be replayed', description: 'TLS 1.3 early data can be captured and replayed. Cloudflare forwards it to the origin with an Early-Data header; a non-idempotent request (a payment, a POST) replayed twice may run twice.', rootCause: '0-RTT is on.', intendedBehavior: 'Off, or the origin rejects or de-duplicates requests marked Early-Data: 1.', fix: ['Speed › Optimization › Protocol › 0-RTT Connection Resumption: off, unless the origin handles Early-Data.'], validation: 'Check that the origin answers 425 Too Early, or ignores replays, for state-changing requests that carry `Early-Data: 1`.' } : null }),
  settingRule({ id: 'tls.opportunistic_encryption', setting: 'opportunistic_encryption', title: 'Opportunistic Encryption', group: 'transport', attackClass: 'Cookie scope and transport', skillRef: WEB, passed: 'Opportunistic Encryption is on.',
    bad: (v) => v === 'off' ? { verdict: 'confirmed', severity: 'info', title: 'Opportunistic Encryption is off', description: 'Browsers that follow plain-HTTP links get no encrypted alternative (only relevant where HTTP is served).', rootCause: 'The setting is off.', intendedBehavior: 'On.', fix: ['SSL/TLS › Edge Certificates › Opportunistic Encryption: on.'] } : null }),
  settingRule({ id: 'client.email_obfuscation', setting: 'email_obfuscation', title: 'Email Address Obfuscation', group: 'client', attackClass: 'Feature abuse and data leakage', skillRef: ATTACK, passed: 'Email obfuscation is on.',
    bad: (v) => v === 'off' ? { verdict: 'confirmed', severity: 'info', title: 'Email addresses on pages are not obfuscated', description: 'Scrapers can harvest addresses from page HTML for spam and phishing.', rootCause: 'The setting is off.', intendedBehavior: 'On, unless pages break.', fix: ['Scrape Shield › Email Address Obfuscation: on.'] } : null }),
  settingRule({ id: 'client.hotlink_protection', setting: 'hotlink_protection', title: 'Hotlink protection', group: 'client', attackClass: 'Feature abuse and data leakage', skillRef: ATTACK, passed: 'Hotlink protection is on.',
    bad: (v) => v === 'off' ? { verdict: 'confirmed', severity: 'info', title: 'Hotlink protection is off', description: 'Other sites can embed the zone\'s images, using its bandwidth.', rootCause: 'The setting is off.', intendedBehavior: 'A decision.', fix: ['Scrape Shield › Hotlink Protection: on, if embedding is not wanted.'] } : null }),
  settingRule({ id: 'client.server_side_exclude', setting: 'server_side_exclude', title: 'Server-side excludes', group: 'client', attackClass: 'Feature abuse and data leakage', skillRef: ATTACK, passed: 'Server-side excludes is on.',
    bad: (v) => v === 'off' ? { verdict: 'confirmed', severity: 'info', title: 'Server-side excludes is off', description: 'Content marked with SSE tags is shown to suspicious visitors too (only matters if the pages use the tags).', rootCause: 'The setting is off.', intendedBehavior: 'On where SSE tags are used.', fix: ['Scrape Shield › Server-side Excludes: on.'] } : null }),
  settingRule({ id: 'waf.challenge_ttl', setting: 'challenge_ttl', title: 'Challenge passage', group: 'waf', attackClass: 'Session fixation and invalidation', skillRef: WEB, passed: `A solved challenge is valid for a day or less.`,
    bad: (v) => Number(v) > LONG_CHALLENGE_TTL ? { verdict: 'confirmed', severity: 'low', title: `A solved challenge stays valid for ${Math.round(Number(v) / 86_400)} days`, description: 'One solved challenge (by a person, or a solver service) lets the same client through every challenge for that long.', rootCause: `challenge_ttl ${v} seconds.`, intendedBehavior: '30 minutes to a day.', fix: ['Security › Settings › Challenge Passage: 30 minutes or 1 hour.'] } : null }),
  settingRule({ id: 'edge.websockets', setting: 'websockets', title: 'WebSockets', group: 'edge', attackClass: 'Cross-site WebSocket request use', skillRef: CLIENT, passed: 'WebSockets are off.',
    bad: (v) => v === 'on' ? { verdict: 'needs_validation', severity: 'info', title: 'WebSockets are on', description: 'Long-lived connections pass through; the WAF inspects the upgrade request, not the messages.', rootCause: 'WebSockets on.', intendedBehavior: 'On only where used; the origin checks the Origin header on upgrade.', fix: ['Network › WebSockets: off if the application does not use them.'], validation: 'If the site uses WebSockets, check that the upgrade handler verifies the Origin header and the session.' } : null }),
  settingRule({ id: 'waf.ip_geolocation', setting: 'ip_geolocation', title: 'IP geolocation header', group: 'waf', attackClass: 'Host and forwarded-header trust', skillRef: WEB, passed: 'IP geolocation is on.',
    bad: (v) => v === 'off' ? { verdict: 'confirmed', severity: 'info', title: 'The CF-IPCountry header is not added', description: 'Country-based logic at the origin cannot rely on Cloudflare\'s header (and may fall back to client-supplied values).', rootCause: 'IP geolocation off.', intendedBehavior: 'On if the origin uses the country.', fix: ['Network › IP Geolocation: on.'] } : null }),
  settingRule({ id: 'tls.automatic_mode', setting: 'ssl_automatic_mode', title: 'Automatic SSL/TLS mode', group: 'transport', attackClass: 'Security-control precedence drift', skillRef: CLOUD, passed: 'The SSL/TLS mode is set by hand.',
    bad: (v) => v === 'auto' ? { verdict: 'confirmed', severity: 'info', title: 'Cloudflare chooses the SSL/TLS mode automatically', description: 'The encryption mode can change without a person deciding it (Cloudflare picks the strictest mode the origin supports).', rootCause: 'ssl_automatic_mode is auto.', intendedBehavior: 'A decision either way.', fix: ['SSL/TLS › Overview: keep Automatic, or choose Custom and Full (strict).'] } : null }),
  {
    id: 'tls.universal_ssl', title: 'Universal SSL', group: 'transport', attackClass: 'Certificate lifecycle fallback', skillRef: WEB,
    needs: ['universal_ssl', 'certificates'], passed: 'Universal SSL is on, or other active certificates cover the zone.',
    check: (c) => {
      if (c.v<{ enabled?: boolean }>('universal_ssl')?.enabled !== false) return [];
      const others = (c.v<CertPack[]>('certificates') ?? []).filter((p) => p.status === 'active' && p.type !== 'universal');
      if (others.length) return [];
      return [{ verdict: 'confirmed', severity: 'high', title: 'Universal SSL is off and no other edge certificate is active', description: 'Proxied hostnames have no certificate at the edge: HTTPS fails for visitors.', rootCause: 'Universal SSL disabled with no advanced or custom certificate.',
        intendedBehavior: 'Universal SSL on, or an active advanced/custom certificate.', evidence: [ev('GET /zones/{id}/ssl/universal/settings', 'enabled', false), ev('GET /zones/{id}/ssl/certificate_packs?status=all', 'other active packs', 0)],
        fix: ['SSL/TLS › Edge Certificates › Disable Universal SSL: turn Universal SSL back on, or order an advanced certificate.'] }];
    },
  },
];

// ── API Shield ──────────────────────────────────────────────────────────────

const API: RuleDef[] = [
  {
    id: 'api.shield', title: 'API Shield on API traffic', group: 'api', attackClass: 'API-key scope and resource binding', skillRef: WEB,
    needs: ['requests', 'schema_validation', 'api_operations'], passed: `API paths are under ${Math.round(API_SHARE * 100)}% of requests, or schema validation acts on saved endpoints.`,
    check: (c) => {
      const req = c.v<RequestData>('requests');
      const all = req.paths.reduce((a, p) => a + p.count, 0);
      const api = req.paths.filter((p) => API_PATH.test(p.path)).reduce((a, p) => a + p.count, 0);
      if (all < API_MIN || api / all < API_SHARE) return [];
      const ops = Number(c.v<{ total?: number }>('api_operations')?.total ?? 0);
      const action = String(c.v<{ validation_default_mitigation_action?: string }>('schema_validation')?.validation_default_mitigation_action ?? 'none');
      if (ops > 0 && action !== 'none') return [];
      return [{ verdict: 'needs_validation', severity: 'info', title: `API paths are ${Math.round((api / all) * 100)}% of requests, without schema validation${ops ? '' : ' or saved endpoints'}`,
        description: 'Requests that do not match the API\'s schema (unexpected fields, types, methods) reach the origin unchecked.', rootCause: `${ops} saved endpoints; schema validation default action ${action}.`,
        intendedBehavior: 'Endpoints saved in API Shield, a schema uploaded, and validation set to log, then block.',
        evidence: [ev('GraphQL httpRequestsAdaptiveGroups', 'requests to API-like paths', `${api} of ${all}`), ev('GET /zones/{id}/api_gateway/operations', 'saved endpoints', ops), ev('GET /zones/{id}/schema_validation/settings', 'validation_default_mitigation_action', action)],
        fix: ['Security › API Shield: save the discovered endpoints, upload the OpenAPI schema, set schema validation to Log, then Block.'],
        validation: 'API Shield needs an add-on on most plans; check the subscription, and whether the API already validates input itself.' }];
    },
  },
];

export const EXTRA_RULES: RuleDef[] = [...MANAGED, ...BYPASS, ...BOTS, ...RATE, ...SETTINGS, ...API];
