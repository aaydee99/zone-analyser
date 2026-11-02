// WAF false-positive finder: the heuristics. Pure functions, shared by server and client (and the
// unit tests) — no Node imports. A rule that blocks or challenges many unrelated clients on ordinary
// browsers, mostly from consumer networks, on paths that otherwise answer 2xx/3xx — and whose
// challenges people solve — is more likely to stop real visitors than attackers. Each signal adds
// or takes points and says why, so the score can be checked by hand. It is a heuristic: it ranks
// what to look at first; it does not prove a false positive.

import type { WafFix, WafSignal, WafSuspect } from './investigate-types';
import { compactNum } from './num';
import { OWASP_ANOMALY_RULE, OWASP_RULESET } from './traffic-types';
import { OWASP_DEFAULT_THRESHOLD, actionLabel, sourceLabel, thresholdLabel } from './waf-labels';

/** "managed_challenge", "managedChallenge" and "managedchallenge" are the same action. */
export const normAction = (a: string) => a.toLowerCase().replace(/[_\s-]/g, '');
const ISSUED = new Set(['challenge', 'jschallenge', 'managedchallenge']);
export const isSolved = (a: string) => /solved|bypassed/.test(normAction(a));
export const isChallenge = (a: string) => ISSUED.has(normAction(a));
export const isBlock = (a: string) => ['block', 'connectionclose', 'forceconnectionclose'].includes(normAction(a));
/** Actions that are not the rule acting on the request (it only logged or let it through). */
export const PASSIVE_ACTIONS = ['log', 'allow', 'skip', 'bypass'];

/** Hosting, cloud and proxy networks; anything else counts as a consumer (residential or mobile) network. */
const HOSTING = /amazon|aws|google|microsoft|azure|digitalocean|ovh|hetzner|linode|akamai|alibaba|tencent|oracle|contabo|vultr|choopa|m247|leaseweb|scaleway|online s\.a\.s|hostinger|hosting|host europe|datacent(er|re)|data cent(er|re)|cloud|server|vps|dedicated|ionos|1&1|godaddy|rackspace|ikoula|psychz|quadranet|serverius|selectel|timeweb|aeza|stark industries|cdn77|datacamp|zenlayer|cogent|hurricane electric|internet archive|facebook|apple|cloudflare/i;
export const isHostingAsn = (name: string) => HOSTING.test(name);

const BROWSER = /^Mozilla\/5\.0 \(.+\) .*(Chrome|Firefox|Safari|Edg|OPR)\/[\d.]+/;
const NOT_BROWSER = /bot|crawl|spider|scan|curl|wget|python|go-http|java\/|okhttp|axios|node-fetch|headless|phantom|libwww|httpclient|postman|insomnia|sqlmap|nikto|nmap|masscan|zgrab/i;
export const isBrowserUa = (ua: string) => BROWSER.test(ua) && !NOT_BROWSER.test(ua);

export interface RuleStats {
  ruleId: string; rulesetId: string; source: string; description: string;
  /** Events per action (as Cloudflare names it). */
  actions: Record<string, number>;
  ips: { ip: string; count: number }[];
  asns: { asn: string; name: string; count: number }[];
  paths: { host: string; path: string; count: number }[];
  uas: { ua: string; count: number }[];
}

const sum = (xs: { count: number }[]) => xs.reduce((n, x) => n + x.count, 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The longest common leading path (whole segments) of a few paths: "/api/v2/" of "/api/v2/a" and "/api/v2/b". */
export function commonPrefix(paths: string[]): string {
  if (!paths.length) return '/';
  const split = paths.map((p) => p.split('/'));
  const out: string[] = [];
  for (let i = 0; i < split[0].length - 1; i++) {
    const seg = split[0][i];
    if (split.every((s) => s.length - 1 > i && s[i] === seg)) out.push(seg); else break;
  }
  return `${out.join('/')}/`;
}

/** Minimum mitigations for a rule to be judged at all (fewer says nothing). */
export const MIN_EVENTS = 10;

/**
 * The score (0–100) and the signals behind it. `okShare`: of the requests to the rule's main path
 * that security did not stop, the share that answered 2xx or 3xx (null when it could not be read).
 */
export function scoreRule(s: RuleStats, okShare: number | null): { score: number; signals: WafSignal[]; mitigated: number; challenged: number; solved: number; blocked: number; residentialShare: number; browserShare: number; pathShare: number } {
  const signals: WafSignal[] = [];
  const add = (key: string, label: string, points: number, detail: string) => { if (points) signals.push({ key, label, points, detail }); };
  let challenged = 0, solved = 0, blocked = 0, other = 0;
  for (const [a, n] of Object.entries(s.actions)) {
    if (isSolved(a)) solved += n; else if (isChallenge(a)) challenged += n; else if (isBlock(a)) blocked += n; else if (!PASSIVE_ACTIONS.includes(normAction(a))) other += n;
  }
  const mitigated = challenged + blocked + other;
  const ipTotal = sum(s.ips) || 1;
  const topIp = s.ips.length ? Math.max(...s.ips.map((x) => x.count)) / ipTotal : 1;
  const asnTotal = sum(s.asns) || 1;
  const residentialShare = s.asns.length ? sum(s.asns.filter((a) => !isHostingAsn(a.name))) / asnTotal : 0;
  const uaTotal = sum(s.uas) || 1;
  const browserShare = s.uas.length ? sum(s.uas.filter((u) => isBrowserUa(u.ua))) / uaTotal : 0;
  const pathTotal = sum(s.paths) || 1;
  const pathShare = s.paths.length ? Math.max(...s.paths.map((p) => p.count)) / pathTotal : 0;

  const ips = s.ips.length;
  add('ips', 'Many different clients', ips >= 50 ? 20 : ips >= 20 ? 12 : ips >= 5 ? 5 : 0, `${ips}${ips >= 2000 ? '+' : ''} distinct IP addresses`);
  if (ips >= 5) add('spread', 'No single client dominates', topIp < 0.1 ? 10 : 0, `the busiest IP has ${pct(topIp)} of the events`);
  add('one-client', 'One client dominates', topIp > 0.5 ? -15 : 0, `one IP has ${pct(topIp)} of the events — more like one attacker or bot`);
  const asns = s.asns.length;
  add('asns', 'Many networks', asns >= 10 ? 10 : asns >= 4 ? 5 : 0, `${asns} networks (ASNs)`);
  add('residential', residentialShare >= 0.4 ? 'Mostly consumer networks' : 'Mostly hosting networks', residentialShare >= 0.7 ? 15 : residentialShare >= 0.4 ? 8 : residentialShare < 0.2 && asns ? -10 : 0,
    `${pct(residentialShare)} of the events from residential or mobile networks (not hosting / cloud)`);
  add('browsers', browserShare >= 0.5 ? 'Ordinary browsers' : 'Few browsers', browserShare >= 0.8 ? 15 : browserShare >= 0.5 ? 8 : browserShare < 0.2 && s.uas.length ? -10 : 0,
    `${pct(browserShare)} of the events with a normal browser user agent`);
  if (okShare !== null) add('ok-path', 'The path normally works', okShare >= 0.9 ? 15 : okShare >= 0.7 ? 8 : 0, `${pct(okShare)} of the other requests to that path answered 2xx/3xx`);
  if (challenged >= MIN_EVENTS) {
    const rate = solved / challenged;
    add('solved', 'Challenges are solved', rate >= 0.5 ? 20 : rate >= 0.2 ? 10 : 0, `${pct(rate)} of ${compactNum(challenged)} challenges were solved (a person or a real browser passed)`);
  }
  add('one-path', 'One rule, one path', pathShare >= 0.8 && mitigated >= 50 ? 10 : 0, `${pct(pathShare)} of its mitigations hit one path`);
  const score = Math.max(0, Math.min(100, signals.reduce((n, x) => n + x.points, 0)));
  return { score, signals, mitigated, challenged, solved, blocked, residentialShare, browserShare, pathShare };
}

// ── Draft exception ─────────────────────────────────────────────────────────

/** A string literal in Cloudflare's rules language. */
export const ruleString = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Legacy products a custom rule can skip, by the security event source that names them. */
const PRODUCT_OF: Record<string, string> = { securitylevel: 'securityLevel', bic: 'bic', hot: 'hot', uablock: 'uaBlock', zonelockdown: 'zoneLockdown', waf: 'waf' };

/** The exception to add in the dashboard, as text. The console never creates it. */
export function draftException(s: Pick<WafSuspect, 'ruleId' | 'rulesetId' | 'source' | 'description' | 'rulesetName' | 'host' | 'path' | 'pathShare'>, paths: string[]): WafSuspect['draft'] {
  const src = s.source.toLowerCase();
  const prefix = commonPrefix(paths.slice(0, 3));
  const pathPart = s.pathShare >= 0.5 || prefix === '/'
    ? `http.request.uri.path eq ${ruleString(s.path)}`
    : `starts_with(http.request.uri.path, ${ruleString(prefix)})`;
  const expression = s.host ? `(http.host eq ${ruleString(s.host)} and ${pathPart})` : `(${pathPart})`;
  const notes = ['Narrow it further before you add it (for example to a method, a query argument, or your own known clients): a skip lets everything it matches through that rule.'];
  if (src === 'firewallmanaged' && s.rulesetId) {
    return {
      phase: 'http_request_firewall_managed', where: `Security › WAF › Managed rules › Add exception — place it before the rule that deploys ${s.rulesetName ?? s.rulesetId}`,
      expression, action: 'skip', actionParameters: { rules: { [s.rulesetId]: [s.ruleId] } },
      notes: ['Skips only this one managed rule, and only for requests the expression matches.', ...notes],
    };
  }
  if (src === 'firewallcustom') {
    return {
      phase: 'http_request_firewall_custom', where: `Security › WAF › Custom rules › edit the rule “${s.description || s.ruleId}”`,
      expression: `(<the rule's current expression>) and not ${expression}`, action: 'edit the rule’s expression', actionParameters: {},
      notes: ['A custom rule is yours: exclude the legitimate traffic in its own expression instead of adding a skip rule.', ...notes],
    };
  }
  if (src === 'ratelimit') {
    return {
      phase: 'http_ratelimit', where: `Security › WAF › Rate limiting rules › edit the rule “${s.description || s.ruleId}” (or add a custom rule that skips rate limiting)`,
      expression: `(<the rule's current expression>) and not ${expression}`, action: 'edit the rule’s expression', actionParameters: {},
      notes: ['Raising the rule’s threshold or counting by a better characteristic (e.g. a session cookie) is often the better fix.', 'Alternative: a custom rule with action skip and { "phases": ["http_ratelimit"] } — that skips every rate limiting rule for what it matches.', ...notes],
    };
  }
  if (src === 'botfight' || src === 'botmanagement') {
    return {
      phase: 'http_request_firewall_custom', where: 'Security › WAF › Custom rules › Create rule, action Skip, before any other rule',
      expression, action: 'skip', actionParameters: { phases: ['http_request_sbfm'] },
      notes: ['Skips Super Bot Fight Mode only (Pro plans and above). Bot Fight Mode on the Free plan cannot be skipped — it can only be turned off.', ...notes],
    };
  }
  if (PRODUCT_OF[src]) {
    return {
      phase: 'http_request_firewall_custom', where: 'Security › WAF › Custom rules › Create rule, action Skip, before any other rule',
      expression, action: 'skip', actionParameters: { products: [PRODUCT_OF[src]] },
      notes: [...notes],
    };
  }
  return {
    phase: '', where: `No skip exists for this source (${s.source}): adjust the feature itself in the dashboard`,
    expression, action: 'none', actionParameters: {}, notes: src === 'l7ddos' ? ['HTTP DDoS rules are tuned with an override of the HTTP DDoS attack protection ruleset (sensitivity or action), not skipped.'] : notes,
  };
}

// ── What the rule does, and how to stop the false positive ──────────────────

/** What the rule did to these requests, by action, most first. */
export const actionsOf = (actions: Record<string, number>) =>
  Object.entries(actions).filter(([, n]) => n > 0).map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count);

/** The rule's main action on these requests (challenges people solved are not an action of their own). */
export function currentActionOf(actions: Record<string, number>): string {
  const acting = actionsOf(actions).filter((x) => !isSolved(x.action) && !PASSIVE_ACTIONS.includes(normAction(x.action)));
  return acting[0]?.action ?? actionsOf(actions)[0]?.action ?? '';
}

type FixInput = Pick<WafSuspect, 'ruleId' | 'rulesetId' | 'source' | 'description' | 'rulesetName' | 'host' | 'path' | 'currentAction' | 'draft' | 'deploy'>;

/** Ways to stop the false positive, the narrowest first: what to change, where, and what else it affects. */
export function fixesOf(s: FixInput): WafFix[] {
  const src = s.source.toLowerCase();
  const d = s.draft;
  const where = `${s.host}${s.path}`;
  const rule = s.description ? `“${s.description}”` : `rule ${s.ruleId}`;
  const blocks = isBlock(s.currentAction);
  const fixes: WafFix[] = [];
  const exception = (title: string, why: string): WafFix => ({
    title, best: true, why,
    steps: [d.where, `Expression: ${d.expression}`, ...(d.action === 'skip' ? [`Action: Skip — ${JSON.stringify(d.actionParameters)}`] : [])],
  });
  const toChallenge = (steps: string[]): WafFix => ({
    title: `Change the action from ${actionLabel(s.currentAction)} to Managed challenge`,
    why: 'Real visitors pass a managed challenge without noticing; most attack tools do not. Applies everywhere the rule matches, not only this path.',
    steps,
  });

  if (src === 'firewallmanaged' && s.rulesetId) {
    const rs = s.rulesetName ?? 'the managed ruleset';
    const configure = `Security › WAF › Managed rules › ${rs} › Configure`;
    if (s.rulesetId === OWASP_RULESET) {
      const o = s.deploy?.owasp;
      fixes.push(exception(`Add an exception: skip ${s.ruleId === OWASP_ANOMALY_RULE ? 'OWASP scoring' : rule} on ${where}`, s.ruleId === OWASP_ANOMALY_RULE
        ? '949110 is OWASP’s score rule: it acts once the OWASP rules that matched add up to the threshold. Skipping it turns OWASP blocking off on this path only. Narrower still: skip just the OWASP rules that scored these requests (open one of the events in Security › Events to see them).'
        : 'Only requests the expression matches stop meeting this OWASP rule; everything else stays protected.'));
      const threshold = o?.threshold ?? OWASP_DEFAULT_THRESHOLD;
      if (threshold < 60) fixes.push({ title: `Lower OWASP’s sensitivity: anomaly score threshold ${thresholdLabel(threshold)} → ${thresholdLabel(60)}`,
        why: 'More OWASP rules must match before it acts, so ordinary requests that trip one or two rules get through. Applies to the whole zone.',
        steps: [configure, `Anomaly Score Threshold: ${thresholdLabel(60)}`, 'Save'] });
      if (o && o.paranoia > 1) fixes.push({ title: `Lower the paranoia level: PL${o.paranoia} → PL${o.paranoia - 1}`,
        why: 'Higher paranoia levels add rules that also match ordinary traffic. Applies to the whole zone.',
        steps: [configure, `Paranoia Level: PL${o.paranoia - 1}`, 'Save'] });
      const owaspAction = o?.action ?? 'block';
      if (isBlock(owaspAction)) fixes.push({ title: `Change the OWASP action from ${actionLabel(owaspAction)} to Managed challenge`,
        why: 'Visitors OWASP flags by mistake can still get in; most attack tools cannot. Applies to the whole zone.',
        steps: [configure, 'OWASP Action: Managed Challenge', 'Save'] });
      return fixes;
    }
    fixes.push(exception(`Add an exception: skip ${rule} on ${where}`, `Only requests the expression matches stop meeting this one rule; every other rule of ${rs} keeps checking them.`));
    const browse = [`${configure} › Browse rules`, `Search for ${s.ruleId}${s.description ? ` (${s.description})` : ''}`];
    if (blocks) fixes.push(toChallenge([...browse, 'Action: Managed Challenge (or Log while you check what it matches)', 'Save']));
    fixes.push({ title: 'Turn this rule off', why: 'Last resort, only if the rule protects something your site does not run (for example a WordPress rule on a site that is not WordPress). Applies to the whole zone.',
      steps: [...browse, 'Status: Disabled', 'Save'] });
    return fixes;
  }
  if (src === 'firewallcustom') {
    fixes.push(exception('Exclude this traffic in the rule’s own expression', 'A custom rule is yours: leave the legitimate requests out of it rather than adding a skip rule.'));
    if (blocks) fixes.push(toChallenge([`Security › WAF › Custom rules › edit ${rule}`, 'Then take action: Managed Challenge', 'Save']));
    return fixes;
  }
  if (src === 'ratelimit') {
    const edit = `Security › WAF › Rate limiting rules › edit ${rule}`;
    fixes.push(exception(`Leave ${where} out of the rule`, 'Requests to this path stop counting toward the limit; the rule keeps working everywhere else.'));
    fixes.push({ title: 'Raise the rate', why: 'Look at how many requests the busiest real clients make first, then set the limit above that.', steps: [edit, 'When rate exceeds: a higher number of requests for the same period', 'Save'] });
    fixes.push({ title: 'Count per visitor, not per IP', why: 'People behind one company or mobile network share an IP and are counted together.', steps: [edit, 'With the same characteristics: add a session cookie or header (Enterprise plans)', 'Save'] });
    if (blocks) fixes.push(toChallenge([edit, 'Then take action: Managed Challenge', 'Save']));
    return fixes;
  }
  if (src === 'botfight') {
    fixes.push({ title: 'Turn Bot Fight Mode off, or move to Super Bot Fight Mode', best: true,
      why: 'Bot Fight Mode cannot be skipped for a path. Super Bot Fight Mode (Pro plans and above) can, with an exception.', steps: ['Security › Bots', 'Bot Fight Mode: Off'] });
    return fixes;
  }
  if (src === 'superbotfight' || src === 'botmanagement') {
    fixes.push(exception(`Add an exception: skip bot protection on ${where}`, 'Only requests the expression matches skip Super Bot Fight Mode.'));
    fixes.push({ title: 'Challenge “Definitely automated” traffic instead of blocking it', why: 'Real visitors misjudged as bots can still get in. Applies to the whole zone.',
      steps: ['Security › Bots › Configure Super Bot Fight Mode', 'Definitely automated: Managed Challenge', 'Save'] });
    return fixes;
  }
  if (src === 'l7ddos' || src === 'l7ddos-managed') {
    fixes.push({ title: 'Lower this DDoS rule’s sensitivity', best: true,
      why: 'HTTP DDoS rules are tuned, not skipped. A lower sensitivity needs more traffic before the rule acts.',
      steps: ['Security › DDoS › HTTP DDoS attack protection › Deploy a DDoS override', `Override rule ${s.ruleId}${s.description ? ` (${s.description})` : ''}`, 'Sensitivity level: Low (or Action: Log while you check)', 'Save'] });
    return fixes;
  }
  if (['ip', 'iprange', 'asn', 'country'].includes(src)) {
    fixes.push({ title: 'Change the IP access rule', best: true, why: 'An IP access rule matches the client (IP, network or country), not the request: change or remove the rule itself.',
      steps: ['Security › WAF › Tools › IP Access Rules', 'Find the rule that matches these clients', 'Delete it, or change its action to Managed Challenge'] });
    return fixes;
  }
  if (src === 'securitylevel') {
    fixes.push(exception(`Add an exception: skip Security Level on ${where}`, 'Only requests the expression matches skip the IP reputation check.'));
    fixes.push({ title: 'Lower the Security Level', why: 'Fewer visitors with a poor IP reputation are challenged. Applies to the whole zone.', steps: ['Security › Settings', 'Security Level: Low (or Essentially off)', 'Save'] });
    return fixes;
  }
  if (src === 'bic') {
    fixes.push(exception(`Add an exception: skip Browser Integrity Check on ${where}`, 'Only requests the expression matches skip the check.'));
    fixes.push({ title: 'Fix the client', why: 'Browser Integrity Check stops requests with missing or unusual headers — usually scripts and API clients, not browsers.', steps: ['Have the client send a normal User-Agent and Accept headers'] });
    return fixes;
  }
  if (d.action === 'skip') fixes.push(exception(`Add an exception: skip ${sourceLabel(s.source)} on ${where}`, 'Only requests the expression matches skip this feature.'));
  else fixes.push({ title: `Adjust ${sourceLabel(s.source)}`, best: true, why: d.where, steps: d.notes });
  return fixes;
}
