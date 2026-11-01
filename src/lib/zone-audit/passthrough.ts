// "Traffic it let through": for every security rule that lets matched requests pass — Log rules
// (custom, managed overrides, rate limiting), Skip rules, IP Access allow rules, and challenges
// that were solved — what that traffic consisted of, whether it carried too many bots or malicious
// requests, and one recommended action. Pure; the numbers come from the security events read for
// the window (read.ts), and every threshold is a constant below.
//
// Two kinds of evidence, kept apart:
// - Scores Cloudflare computed (Bot Management bot score, WAF attack score; Enterprise) — used only
//   when at least half of the passed requests carry one. A conclusion from scores is `confirmed`.
// - Heuristics when the plan has no scores: user agents that are not ordinary browsers (bots),
//   threat-like paths and clients other rules blocked or challenged in the window (malicious).
//   A conclusion from heuristics is `needs_validation`.
// Fewer than PASS_MIN passed requests never lead to a conclusion.

import { isBrowserUa, isChallenge, isHostingAsn, isSolved, normAction, PASSIVE_ACTIONS, ruleString } from '../waf-fp-score';
import { sensitivePaths } from './expr';
import type { EventData, PassKind, PassThrough, Recommendation, RuleKind } from './types';

/** Below this many passed requests in the window, nothing is concluded. */
export const PASS_MIN = 100;
/** Too many bots: at least BOT_MIN automated requests and BOT_SHARE of what the rule let through. */
export const BOT_SHARE = 0.3, BOT_MIN = 50;
/** Too much malicious traffic: at least MAL_MIN requests and MAL_SHARE of what the rule let through. */
export const MAL_SHARE = 0.01, MAL_MIN = 10;
/** Rules analysed per audit (the ones that let most traffic through); the rest are listed as not analysed. */
export const PASS_MAX = 25;
/** Bot Management: 1 automated, 2–29 likely automated (Cloudflare's bot score groupings). */
export const BOT_SCORE_MAX = 29;
/** WAF attack score class "attack": 1–20. */
export const ATTACK_SCORE_MAX = 20;
/** Scores are used only when at least this share of the passed requests carries one. */
export const SCORED_SHARE = 0.5;
/** Paths scanners and exploit kits probe (documented list; matched anywhere in the path). */
export const THREAT_PATH = /\/wp-login\.php|\/xmlrpc\.php|\/\.env|\/\.git\/|\/\.aws\/|\/wp-admin\/(setup-config|install)\.php|\/phpmyadmin|\/vendor\/phpunit|\/cgi-bin\/|\.\.\/|%2e%2e|\/etc\/passwd|\/actuator\/|\/server-status|\/boaform|\/hnap1|\/solr\/admin|\/console\/login|\.(bak|sql|old|swp)$/i;

/** How an action lets a request through, or null when it stopped it. */
export function passKindOf(action: string): PassKind | null {
  const a = normAction(action);
  if (isSolved(action)) return 'solved';
  if (a === 'log') return 'log';
  if (a === 'skip' || a === 'bypass') return 'skip';
  if (a === 'allow' || a === 'whitelist') return 'allow';
  return null;
}
const stops = (a: string) => !PASSIVE_ACTIONS.includes(normAction(a)) && !isSolved(a);
const sum = (xs: { count: number }[]) => xs.reduce((a, x) => a + x.count, 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const top = <T extends { count: number }>(xs: T[], k = 5) => [...xs].sort((a, b) => b.count - a.count).slice(0, k);
const merge = <T extends { count: number }>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T>();
  for (const x of xs) { const k = key(x); const y = m.get(k); if (y) y.count += x.count; else m.set(k, { ...x }); }
  return [...m.values()];
};

export interface PassRule {
  key: string;
  source: string;
  ruleId: string;
  name: string;
  kind: RuleKind;
  actions: Record<string, number>;
  /** The rule's expression in the zone's configuration (custom, rate limiting), for drafting. */
  expression?: string;
  /** For an IP Access allow rule: what it allows ("ip 192.0.2.1", "country NL"). */
  allowTarget?: string;
}

/** The traffic one rule let through, its make-up and the recommendation; null when it let nothing through. */
export function analysePassThrough(d: EventData, r: PassRule, fingerprint: string): PassThrough | null {
  const passActions = Object.keys(r.actions).filter((a) => passKindOf(a));
  const passed = passActions.reduce((a, x) => a + r.actions[x], 0);
  if (!passed) return null;
  const kinds = [...new Set(passActions.map((a) => passKindOf(a)!))];
  const mine = <T extends { ruleId: string; source: string; action?: string }>(rows: T[] | null) =>
    (rows ?? []).filter((x) => x.ruleId === r.ruleId && x.source.toLowerCase() === r.source.toLowerCase() && (x.action === undefined || passKindOf(x.action)));

  const uas = merge(mine(d.uas), (x) => x.ua);
  const asns = merge(mine(d.asns), (x) => x.asn);
  const paths = merge(mine(d.paths), (x) => `${x.host}${x.path}`);
  const ips = mine(d.ips);
  const browserShare = sum(uas) ? sum(uas.filter((u) => isBrowserUa(u.ua))) / sum(uas) : 0;
  const hostingShare = sum(asns) ? sum(asns.filter((a) => isHostingAsn(a.name))) / sum(asns) : 0;

  // Bots: Bot Management scores when they cover the passed traffic, else user agents.
  const botRows = mine(d.bots);
  const scored = sum(botRows.filter((b) => b.score > 0));
  const botBasis: PassThrough['botBasis'] = scored >= passed * SCORED_SHARE ? 'score' : 'heuristic';
  const bots = botBasis === 'score'
    ? sum(botRows.filter((b) => b.score > 0 && b.score <= BOT_SCORE_MAX && !b.verified))
    : sum(uas) ? Math.round(passed * (1 - browserShare)) : 0;

  // Malicious: WAF attack scores when they cover the passed traffic, else threat paths and repeat offenders.
  const attackRows = mine(d.attacks);
  const attackScored = sum(attackRows.filter((a) => a.score >= 1 && a.score <= 99));
  const maliciousBasis: PassThrough['maliciousBasis'] = attackScored >= passed * SCORED_SHARE ? 'attack_score' : 'heuristic';
  const threatPathHits = sum(paths.filter((p) => THREAT_PATH.test(p.path)));
  const stoppedIps = new Set(d.ips.filter((i) => stops(i.action) && !(i.ruleId === r.ruleId && i.source.toLowerCase() === r.source.toLowerCase())).map((i) => i.ip));
  const repeatOffenderHits = sum(ips.filter((i) => stoppedIps.has(i.ip)));
  const malicious = maliciousBasis === 'attack_score' ? sum(attackRows.filter((a) => a.score >= 1 && a.score <= ATTACK_SCORE_MAX)) : Math.max(threatPathHits, repeatOffenderHits);

  const st = mine(d.statuses);
  const statuses = d.statuses ? { s2xx: sum(st.filter((x) => x.status >= 200 && x.status < 300)), s3xx: sum(st.filter((x) => x.status >= 300 && x.status < 400)), s4xx: sum(st.filter((x) => x.status >= 400 && x.status < 500)), s5xx: sum(st.filter((x) => x.status >= 500)) } : null;
  const hourly = merge(mine(d.hours), (x) => x.hour);
  const peakPerHour = d.hours ? (hourly.length ? Math.max(...hourly.map((h) => h.count)) : 0) : null;
  let challenged = 0, solved = 0;
  for (const [a, c] of Object.entries(r.actions)) { if (isSolved(a)) solved += c; else if (isChallenge(a)) challenged += c; }
  const solveRate = kinds.includes('solved') && challenged + solved > 0 ? solved / Math.max(challenged, solved) : null;
  const sensitiveHits = sum(paths.filter((p) => sensitivePaths(p.path).length > 0));

  const botShare = passed ? Math.min(1, bots / passed) : 0;
  const maliciousShare = passed ? Math.min(1, malicious / passed) : 0;
  const verdict: PassThrough['verdict'] = passed < PASS_MIN ? 'too_few'
    : malicious >= MAL_MIN && maliciousShare >= MAL_SHARE ? 'malicious'
      : bots >= BOT_MIN && botShare >= BOT_SHARE ? 'bots' : 'clean';
  const p: Omit<PassThrough, 'recommendation'> = {
    kinds, passed, bots, botShare, botBasis, malicious, maliciousShare, maliciousBasis, threatPathHits, repeatOffenderHits, hostingShare, browserShare, sensitiveHits, statuses, peakPerHour, solveRate,
    topPaths: top(paths.map((x) => ({ path: x.path, count: x.count }))),
    topAsns: top(asns.map((a) => ({ asn: a.asn, name: a.name, count: a.count, hosting: isHostingAsn(a.name) }))),
    topUas: top(uas.map((u) => ({ ua: u.ua, count: u.count, browser: isBrowserUa(u.ua) }))),
    topCountries: top(merge(mine(d.countries), (x) => x.country).map((c) => ({ country: c.country, count: c.count }))),
    verdict,
  };
  return { ...p, recommendation: recommend(r, p, verdict === 'bots' || verdict === 'malicious' ? fingerprint : undefined) };
}

/** The condition that singles out the bad slice of what the rule let through (for a narrowed rule), or null. */
function exclusion(p: Omit<PassThrough, 'recommendation'>): string | null {
  const parts: string[] = [];
  if (p.verdict === 'malicious') {
    if (p.maliciousBasis === 'attack_score') parts.push('cf.waf.score lt 21');
    else {
      const threat = p.topPaths.filter((x) => THREAT_PATH.test(x.path)).map((x) => ruleString(x.path));
      if (threat.length) parts.push(`http.request.uri.path in {${threat.join(' ')}}`);
    }
  }
  if (p.verdict === 'bots' || p.verdict === 'malicious') {
    if (p.botBasis === 'score') parts.push('(cf.bot_management.score lt 30 and not cf.bot_management.verified_bot)');
    else {
      const hosting = p.topAsns.filter((a) => a.hosting && /^\d+$/.test(a.asn)).map((a) => a.asn);
      if (hosting.length) parts.push(`ip.src.asnum in {${hosting.join(' ')}}`);
    }
  }
  return parts.length ? parts.join(' or ') : null;
}

function recommend(r: PassRule, p: Omit<PassThrough, 'recommendation'>, fingerprint?: string): Recommendation {
  const name = `“${r.name}”`;
  // Bots and malicious requests overlap (a scanner is both): never more than what passed.
  const impact = p.verdict === 'bots' || p.verdict === 'malicious' ? Math.min(p.passed, p.bots + p.malicious) : 0;
  const what = p.verdict === 'malicious' ? `${p.malicious} malicious requests (${p.maliciousBasis === 'attack_score' ? 'WAF attack score 1–20' : 'threat-like paths or clients other rules stopped'})`
    : `${p.bots} automated requests (${pct(p.botShare)}; ${p.botBasis === 'score' ? 'bot score 1–29' : 'non-browser user agents'})`;
  if (p.verdict === 'too_few') return { action: 'no_conclusion', impact: 0, title: `${name}: too few requests to judge`, steps: [`It let ${p.passed} requests through in the window — fewer than ${PASS_MIN}, the minimum the audit concludes from. Look again with the 30-day window.`] };
  if (p.verdict === 'clean') return { action: 'keep', impact: 0, title: `${name}: no action needed`,
    steps: [`It let ${p.passed} requests through; ${pct(p.botShare)} automated (${p.botBasis === 'score' ? 'bot score' : 'user agents'}) and ${p.malicious} malicious (${p.maliciousBasis === 'attack_score' ? 'attack score' : 'threat paths / repeat offenders'}) — under the thresholds (bots ≥ ${pct(BOT_SHARE)} and ≥ ${BOT_MIN}; malicious ≥ ${pct(MAL_SHARE)} and ≥ ${MAL_MIN}). Keep it as is.`] };
  const ex = exclusion(p);
  const rateLimit = p.sensitiveHits || p.topPaths.length
    ? `Add a rate limiting rule on the paths it let bots reach: \`(http.request.uri.path in {${p.topPaths.slice(0, 3).map((x) => ruleString(x.path)).join(' ')}})\`, counting by IP, e.g. 30 requests per minute, action Managed Challenge — start with Log.`
    : null;
  const main = p.kinds.includes('allow') ? 'allow' : p.kinds.includes('skip') ? 'skip' : p.kinds.includes('log') ? 'log' : 'solved';
  if (main === 'log') {
    const to = p.verdict === 'malicious' ? 'Block' : 'Managed Challenge';
    const where = r.kind === 'managed' ? `Security › WAF › Managed rules › Configure: remove the Log override for the rule ${r.ruleId} (or its category), so it uses its default action.`
      : r.kind === 'ratelimit' ? `Security › WAF › Rate limiting rules › ${name}: set the action to ${to === 'Block' ? 'Block' : 'Managed Challenge'}.`
        : `Security › WAF › Custom rules › ${name}: change the action from Log to ${to}.`;
    return { action: 'block_or_challenge', impact, fingerprint, title: `Switch ${name} from Log to ${to}: it let ${what} through`, steps: [where, ...(rateLimit && p.sensitiveHits ? [rateLimit] : [])] };
  }
  if (main === 'skip') return { action: 'narrow', impact, fingerprint, title: `Narrow ${name}: its skip let ${what} through`,
    expression: ex ? `(${r.expression ?? "<the rule's current expression>"}) and not (${ex})` : undefined,
    steps: [`Security › WAF › Custom rules (or Managed rules › Exceptions) › ${name}: ${ex ? 'replace the expression with the one below, so the bad slice no longer skips security.' : 'add a condition that limits the skip to the clients it is for (an IP list, a header only your partner sends, a client certificate).'}`, ...(rateLimit ? [rateLimit] : [])] };
  if (main === 'allow') return { action: 'replace_allow', impact, fingerprint, title: `Replace the IP Access allow rule ${r.allowTarget ? `for ${r.allowTarget} ` : ''}with a narrow skip: it let ${what} through`,
    expression: ex ? `(<the allowed address or range>) and not (${ex})` : undefined,
    steps: ['Security › WAF › Tools › IP Access Rules: delete the allow rule (it skips every security product).', `Security › WAF › Custom rules › Create: action Skip, only the products that must be skipped, expression ${ex ? 'as below' : 'limited to the allowed address and the paths it needs'}.`] };
  return { action: 'rate_limit', impact, fingerprint, title: `Rate limit what passes ${name}'s challenge: ${what} solved it`,
    expression: ex ?? undefined,
    steps: [rateLimit ?? 'Add a rate limiting rule on the challenged paths, counting by IP.', ...(ex ? ['Block the slice below outright with a custom rule placed before this one (challenge solvers are getting through).'] : [])] };
}
