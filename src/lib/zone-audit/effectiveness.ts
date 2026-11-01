// "Rule effectiveness": how each security rule acted on the zone's traffic in the audit window, and
// deterministic recommendations from those numbers. Pure — the security events and request counts
// come in the snapshot (read.ts reads them with GraphQL queries; nothing is changed).
//
// Every recommendation states its numbers and the window. They are `needs_validation` unless the
// numbers alone prove the point (a rule with no events in a week or more did not act on traffic):
// "looks malicious" or "looks like a false positive" are patterns, not proof. The false-positive
// signals and the draft exception are the WAF false-positive finder's (waf-fp-score.ts), reused.

import { draftException, isChallenge, isHostingAsn, isSolved, normAction, scoreRule, MIN_EVENTS, PASSIVE_ACTIONS, ruleString, type RuleStats } from '../waf-fp-score';
import { MANAGED_RULESETS } from '../traffic-types';
import { literalPaths, pathMatches } from './expr';
import { analysePassThrough, PASS_MAX, BOT_SHARE, BOT_MIN, MAL_SHARE, MAL_MIN, PASS_MIN } from './passthrough';
import { CLOUD, RES, type Ctx, type Draft, type RuleDef } from './rules';
import {
  KIND_LABEL, windowLabel,
  PASS_LABEL,
  type AccessRule, type Effectiveness, type EventData, type RequestData, type RuleEffect, type RuleKind, type RulesetRule, type Snapshot, type Verdict,
} from './types';

/** Rules shown in the table (most events first; configured rules without events are added after). */
export const EFFECT_ROWS = 100;
/** waf-fp-score's score from which a mitigating rule is reported as a likely false positive. */
export const FP_SCORE = 50;
/** Managed rules mostly in log: share of a managed ruleset's events that were only logged. */
export const MANAGED_LOG_SHARE = 0.8, MANAGED_LOG_MIN = 100;
/** A rate limiting rule that never triggered while its paths got this many requests. */
export const RL_HEAVY = 10_000;
/** Unmitigated hotspots: requests, 4xx share and the most mitigation that still counts as "none". */
export const HOT_MIN = 1_000, HOT_4XX = 0.5, HOT_MITIGATED_MAX = 0.01, HOT_ASN_SHARE = 0.05;
/** Zero events prove a rule did not act only over a week or more (sampling makes a day weaker). */
export const ZERO_CONFIRM_HOURS = 168;

const kindOf = (source: string): RuleKind => {
  const s = source.toLowerCase();
  if (s === 'firewallcustom' || s === 'firewallrules') return 'custom';
  if (s === 'firewallmanaged' || s === 'waf') return 'managed';
  if (s === 'ratelimit') return 'ratelimit';
  if (s.includes('bot')) return 'bot';
  if (s === 'l7ddos') return 'ddos';
  // IP Access rules log their source as the target type.
  if (s === 'ip' || s === 'iprange' || s === 'asn' || s === 'country') return 'access';
  return 'other';
};
const keyOf = (source: string, rulesetId: string, ruleId: string) => `${source.toLowerCase()}:${rulesetId}:${ruleId}`;
const mitigating = (a: string) => !PASSIVE_ACTIONS.includes(normAction(a)) && !isSolved(a);
/** Actions that let the request through (log, skip, allow, a solved challenge). */
const passes = (a: string) => ['log', 'skip', 'bypass', 'allow', 'whitelist'].includes(normAction(a)) || isSolved(a);
/** Same impact: the stronger change first. */
const ORDER: Record<string, number> = { block_or_challenge: 0, narrow: 1, replace_allow: 2, rate_limit: 3, keep: 4, no_conclusion: 5 };
const pct = (x: number) => `${Math.round(x * 100)}%`;
import { whole as n } from '@/lib/num';
const top = <T extends { count: number }>(xs: T[], k = 5) => [...xs].sort((a, b) => b.count - a.count).slice(0, k);

interface Configured { phase: 'http_request_firewall_custom' | 'http_ratelimit'; rule: RulesetRule }

/** The custom and rate limiting rules of the zone's entrypoints (the ones events can be matched to). */
function configured(s: Snapshot): Configured[] {
  const out: Configured[] = [];
  for (const phase of ['http_request_firewall_custom', 'http_ratelimit'] as const) {
    const g = s.reads[`phase:${phase}`];
    if (g?.state !== 'ok') continue;
    for (const rule of g.value as RulesetRule[]) out.push({ phase, rule });
  }
  return out;
}

const cache = new WeakMap<Snapshot, { eff: Effectiveness; stats: Map<string, RuleStats & { kind: RuleKind }> } | null>();

/** The per-rule table, and each rule's stats in waf-fp-score's shape; null when security events were not read. */
export function effectivenessOf(s: Snapshot) {
  if (cache.has(s)) return cache.get(s)!;
  const g = s.reads.events;
  if (g?.state !== 'ok') { cache.set(s, null); return null; }
  const d = g.value as EventData;
  const stats = new Map<string, RuleStats & { kind: RuleKind }>();
  const statOf = (source: string, rulesetId: string, ruleId: string, description = '') => {
    const k = keyOf(source, rulesetId, ruleId);
    let st = stats.get(k);
    if (!st) stats.set(k, (st = { ruleId, rulesetId, source, description, actions: {}, ips: [], asns: [], paths: [], uas: [], kind: kindOf(source) }));
    return st;
  };
  // Rows without a ruleset id (paths, countries…) are matched by source and rule id.
  const byRule = new Map<string, RuleStats & { kind: RuleKind }>();
  for (const r of d.rules) {
    const st = statOf(r.source, r.rulesetId, r.ruleId, r.description);
    st.actions[r.action] = (st.actions[r.action] ?? 0) + r.count;
    if (!st.description) st.description = r.description;
    byRule.set(`${r.source.toLowerCase()}:${r.ruleId}`, st);
  }
  const find = (source: string, ruleId: string) => byRule.get(`${source.toLowerCase()}:${ruleId}`);
  const countries = new Map<string, Map<string, number>>();
  const actedPaths = new Map<string, Map<string, number>>();
  for (const p of d.paths) {
    const st = find(p.source, p.ruleId);
    if (!st) continue;
    st.paths.push({ host: p.host, path: p.path, count: p.count });
    if (mitigating(p.action)) { const m = actedPaths.get(keyOf(st.source, st.rulesetId, st.ruleId)) ?? new Map(); m.set(p.path, (m.get(p.path) ?? 0) + p.count); actedPaths.set(keyOf(st.source, st.rulesetId, st.ruleId), m); }
  }
  for (const c of d.countries) {
    const st = find(c.source, c.ruleId);
    if (!st) continue;
    const k = keyOf(st.source, st.rulesetId, st.ruleId);
    const m = countries.get(k) ?? new Map();
    m.set(c.country, (m.get(c.country) ?? 0) + c.count);
    countries.set(k, m);
  }
  for (const a of d.asns) find(a.source, a.ruleId)?.asns.push({ asn: a.asn, name: a.name, count: a.count });
  for (const i of d.ips) find(i.source, i.ruleId)?.ips.push({ ip: i.ip, count: i.count });
  for (const u of d.uas) find(u.source, u.ruleId)?.uas.push({ ua: u.ua, count: u.count });

  const prev = s.reads.events_previous?.state === 'ok' ? (s.reads.events_previous.value as EventData) : null;
  const prevBy = new Map<string, number>();
  for (const r of prev?.rules ?? []) prevBy.set(keyOf(r.source, r.rulesetId, r.ruleId), (prevBy.get(keyOf(r.source, r.rulesetId, r.ruleId)) ?? 0) + r.count);

  const conf = configured(s);
  const confBy = new Map(conf.filter((c) => c.rule.id).map((c) => [c.rule.id!, c]));
  const rows: RuleEffect[] = [];
  for (const [k, st] of stats) {
    const events = Object.values(st.actions).reduce((a, b) => a + b, 0);
    let challenged = 0, solved = 0;
    for (const [a, c] of Object.entries(st.actions)) { if (isSolved(a)) solved += c; else if (isChallenge(a)) challenged += c; }
    const c = confBy.get(st.ruleId);
    const previous = prev ? prevBy.get(k) ?? 0 : null;
    const pathsActed = actedPaths.get(k);
    rows.push({
      key: k, kind: st.kind, source: st.source, ruleId: st.ruleId, rulesetId: st.rulesetId,
      name: c?.rule.description?.trim() || st.description || MANAGED_RULESETS[st.rulesetId] || st.ruleId || KIND_LABEL[st.kind],
      configured: !!c, configAction: c?.rule.action ?? null, enabled: c ? c.rule.enabled !== false : null,
      events, byAction: st.actions, challenged, solved, solveRate: challenged >= MIN_EVENTS ? solved / challenged : null,
      topPaths: pathsActed ? top([...pathsActed].map(([path, count]) => ({ path, count }))) : top(mergePaths(st.paths)),
      topCountries: top([...(countries.get(k) ?? new Map<string, number>())].map(([country, count]) => ({ country, count }))),
      topAsns: top(mergeAsns(st.asns)), passthrough: null, previous, trend: previous ? (events - previous) / previous : null,
    });
  }
  rows.sort((a, b) => b.events - a.events || a.key.localeCompare(b.key));
  const shown = rows.slice(0, EFFECT_ROWS);
  // Configured rules that had no events at all are rows too (zero is a result).
  for (const c of conf) {
    if (!c.rule.id || rows.some((r) => r.ruleId === c.rule.id)) continue;
    shown.push({ key: `config:${c.rule.id}`, kind: c.phase === 'http_ratelimit' ? 'ratelimit' : 'custom', source: c.phase === 'http_ratelimit' ? 'ratelimit' : 'firewallCustom', ruleId: c.rule.id, rulesetId: '',
      name: c.rule.description?.trim() || c.rule.id, configured: true, configAction: c.rule.action ?? null, enabled: c.rule.enabled !== false, events: 0, byAction: {}, challenged: 0, solved: 0, solveRate: null,
      topPaths: [], topCountries: [], topAsns: [], passthrough: null, previous: prev ? 0 : null, trend: null });
  }
  // What the rules that let traffic through let through: the PASS_MAX that passed the most.
  const access = new Map<string, AccessRule>();
  for (const k of ['access_rules', 'account_access_rules'] as const) { const a = s.reads[k]; if (a?.state === 'ok') for (const x of a.value as AccessRule[]) access.set(x.id, x); }
  const passedOf = (r: RuleEffect) => Object.entries(r.byAction).filter(([a]) => passes(a)).reduce((t, [, v]) => t + v, 0);
  const passing = rows.filter((r) => passedOf(r) > 0).sort((a, b) => passedOf(b) - passedOf(a) || a.key.localeCompare(b.key));
  const recommendations: Effectiveness['recommendations'] = [];
  for (const r of passing.slice(0, PASS_MAX)) {
    const a = r.kind === 'access' ? access.get(r.ruleId) : undefined;
    if (a?.notes && r.name === r.ruleId) r.name = `IP Access: ${a.notes}`;
    r.passthrough = analysePassThrough(d, {
      key: r.key, source: r.source, ruleId: r.ruleId, name: r.name, kind: r.kind, actions: r.byAction,
      expression: confBy.get(r.ruleId)?.rule.expression, allowTarget: a?.configuration ? `${a.configuration.target} ${a.configuration.value}` : undefined,
    }, `zone:${s.zoneId}:traffic.passthrough:${r.key}`);
    if (r.passthrough) recommendations.push({ ...r.passthrough.recommendation, ruleKey: r.key, ruleName: r.name, kind: r.kind });
    if (!shown.includes(r)) shown.push(r);
  }
  recommendations.sort((a, b) => b.impact - a.impact || ORDER[a.action] - ORDER[b.action] || a.ruleName.localeCompare(b.ruleName));
  const eff: Effectiveness = {
    hours: s.hours ?? 0, askedHours: s.askedHours ?? s.hours ?? 0, since: d.since, until: d.until, previousSince: prev?.since ?? null,
    totalEvents: rows.reduce((a, r) => a + r.events, 0), rules: shown, recommendations,
    notAnalysed: passing.slice(PASS_MAX).map((r) => ({ ruleKey: r.key, ruleName: r.name, passed: passedOf(r), reason: `Only the ${PASS_MAX} rules that let the most traffic through are analysed per audit` })),
    notes: [...d.notes, ...(prev ? [] : ['The window before could not be read (older than the plan keeps, or refused): no trend.']),
      ...(d.bots ? [] : ['Bot scores are not offered on this plan: bot shares come from user agents (a heuristic).']),
      ...(d.attacks ? [] : ['WAF attack scores are not offered on this plan: malicious shares come from threat-like paths and clients other rules stopped (a heuristic).'])],
  };
  const out = { eff, stats };
  cache.set(s, out);
  return out;
}

function mergePaths(ps: { path: string; count: number }[]) {
  const m = new Map<string, number>();
  for (const p of ps) m.set(p.path, (m.get(p.path) ?? 0) + p.count);
  return [...m].map(([path, count]) => ({ path, count }));
}
function mergeAsns(as: { asn: string; name: string; count: number }[]) {
  const m = new Map<string, { asn: string; name: string; count: number }>();
  for (const a of as) { const x = m.get(a.asn) ?? { asn: a.asn, name: a.name, count: 0 }; x.count += a.count; m.set(a.asn, x); }
  return [...m.values()];
}

const winText = (s: Snapshot) => `in the last ${windowLabel(s.hours ?? 0)}`;
const evSrc = 'GraphQL firewallEventsAdaptiveGroups';
const rqSrc = 'GraphQL httpRequestsAdaptiveGroups';
const ev = (source: string, field: string, value: string | number) => ({ source, field, value: String(value) });
const eff = (c: Ctx) => effectivenessOf(c.s)!;
const reqs = (c: Ctx) => c.v<RequestData>('requests');
const mitigatedOnPath = (c: Ctx, host: string, path: string) => (c.v<EventData>('events').paths ?? []).filter((p) => p.path === path && (!host || !p.host || p.host === host) && mitigating(p.action)).reduce((a, p) => a + p.count, 0);

/** The share of a path's requests that answered 2xx/3xx, after taking out the ones security answered (waf-fp's okShare). */
function okShareOf(c: Ctx, host: string, path: string): number | null {
  const r = c.s.reads.requests;
  if (r?.state !== 'ok') return null;
  const rows = (r.value as RequestData).paths.filter((p) => p.path === path && (!host || p.host === host));
  const total = rows.reduce((a, p) => a + p.count, 0);
  const others = total - mitigatedOnPath(c, host, path);
  if (others <= 0) return null;
  return Math.min(1, rows.filter((p) => p.status >= 200 && p.status < 400).reduce((a, p) => a + p.count, 0) / others);
}

const T = { group: 'traffic' as const };

export const TRAFFIC_RULES: RuleDef[] = [
  {
    ...T, id: 'traffic.passthrough', title: 'Bots and malicious requests let through by log, skip, allow and challenge rules', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['events'], passed: `No rule that lets traffic through let ${Math.round(BOT_SHARE * 100)}%+ bots (and ${BOT_MIN}+) or ${Math.round(MAL_SHARE * 100)}%+ malicious requests (and ${MAL_MIN}+) through; rules with fewer than ${PASS_MIN} passed requests are not judged.`,
    check: (c) => eff(c).eff.rules.filter((r) => r.passthrough && (r.passthrough.verdict === 'bots' || r.passthrough.verdict === 'malicious')).map((r): Draft => {
      const p = r.passthrough!;
      const mal = p.verdict === 'malicious';
      const byScore = mal ? p.maliciousBasis === 'attack_score' : p.botBasis === 'score';
      return { resource: r.key, verdict: byScore ? 'confirmed' : 'needs_validation', severity: mal ? 'high' : 'medium',
        title: `${KIND_LABEL[r.kind]} “${r.name}” let ${mal ? `${n.format(p.malicious)} malicious` : `${n.format(p.bots)} automated`} requests through (${pct(mal ? p.maliciousShare : p.botShare)} of ${n.format(p.passed)})`,
        description: `${winText(c.s)} it ${p.kinds.map((k) => PASS_LABEL[k].toLowerCase()).join(', ')} for ${n.format(p.passed)} requests. ${mal
          ? (p.maliciousBasis === 'attack_score' ? `${n.format(p.malicious)} had a WAF attack score of 1–20 (attack).` : `${n.format(p.threatPathHits)} went to threat-like paths and ${n.format(p.repeatOffenderHits)} came from clients other rules blocked or challenged.`)
          : (p.botBasis === 'score' ? `${n.format(p.bots)} had a bot score of 1–29 (verified bots left out).` : `${pct(1 - p.browserShare)} came with a user agent that is not an ordinary browser; ${pct(p.hostingShare)} from hosting networks.`)}${p.sensitiveHits ? ` ${n.format(p.sensitiveHits)} reached login, account, admin or API paths.` : ''}`,
        rootCause: 'The rule lets matched requests through without telling bots and attacks from the traffic it was written for.', intendedBehavior: 'Rules that let traffic through match only the clients they are meant for; bots and attacks among them are challenged or blocked.',
        evidence: [ev(evSrc, 'passed requests', p.passed), ev(evSrc, `automated (${p.botBasis})`, `${p.bots} (${pct(p.botShare)})`), ev(evSrc, `malicious (${p.maliciousBasis})`, `${p.malicious} (${pct(p.maliciousShare)})`),
          ev(evSrc, 'from hosting networks', pct(p.hostingShare)), ev(evSrc, 'with a browser user agent', pct(p.browserShare)), ...(p.statuses ? [ev(evSrc, 'responses 2xx / 4xx / 5xx', `${p.statuses.s2xx} / ${p.statuses.s4xx} / ${p.statuses.s5xx}`)] : []),
          ...(p.peakPerHour !== null ? [ev(evSrc, 'busiest hour', p.peakPerHour)] : []), ...p.topAsns.slice(0, 3).map((a) => ev(evSrc, `network AS${a.asn}`, `${a.name}: ${a.count}`)), ...p.topPaths.slice(0, 3).map((x) => ev(evSrc, `path ${x.path}`, x.count)), ev('window', 'hours', c.s.hours ?? 0)],
        fix: [p.recommendation.title, ...p.recommendation.steps, ...(p.recommendation.expression ? [`Expression: ${p.recommendation.expression}`] : [])],
        validation: byScore ? undefined : 'Open Security › Events filtered to this rule and look at a sample: scripted user agents, hosting networks and probe paths confirm it; a known partner or monitor means it is fine (exclude it by IP instead).' };
    }),
  },
  {
    ...T, id: 'traffic.zero_hits', title: 'Rules that did not act in the window', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['events', 'phase:http_request_firewall_custom', 'phase:http_ratelimit'], passed: 'Every enabled custom and rate limiting rule matched traffic in the window.',
    check: (c) => {
      const e = eff(c);
      const out: Draft[] = [];
      for (const r of e.eff.rules) {
        if (!r.configured || r.events || r.enabled === false) continue;
        const rule = configured(c.s).find((x) => x.rule.id === r.ruleId)?.rule;
        // A skip rule that does not log its matches leaves no events: zero says nothing.
        if (rule?.action === 'skip' && rule.logging?.enabled === false) continue;
        const confirmedZero = (c.s.hours ?? 0) >= ZERO_CONFIRM_HOURS;
        out.push({ resource: r.ruleId, verdict: confirmedZero ? 'confirmed' : 'needs_validation', severity: 'info', title: `${KIND_LABEL[r.kind]} “${r.name}” had no events ${winText(c.s)}`,
          description: `No security event names this rule ${winText(c.s)} (${e.eff.since.slice(0, 10)} – ${e.eff.until.slice(0, 10)}). It may protect against something rare, or no longer match anything.`,
          rootCause: 'The rule\'s expression matched no sampled request in the window.', intendedBehavior: 'Every rule has a purpose that is still current.',
          evidence: [ev(evSrc, `events for rule ${r.ruleId}`, 0), ev('window', 'hours', c.s.hours ?? 0), ev(`GET /zones/{id}/rulesets/phases/${r.kind === 'ratelimit' ? 'http_ratelimit' : 'http_request_firewall_custom'}/entrypoint`, `${r.name}.action`, r.configAction ?? '')],
          fix: [`Review “${r.name}”: keep it if it guards against a rare event (document why), otherwise delete it. Nothing is changed by the audit.`],
          validation: 'Security events are sampled: check a longer window (30 days) before deleting a rule that guards against rare traffic.' });
      }
      return out;
    },
  },
  {
    ...T, id: 'traffic.false_positive', title: 'Rules that probably stop real visitors', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['events'], passed: `No blocking or challenging rule scored ${FP_SCORE}+ on the false-positive signals.`,
    check: (c) => {
      const out: Draft[] = [];
      for (const [, st] of eff(c).stats) {
        const paths = [...st.paths].sort((a, b) => b.count - a.count);
        const main = paths[0];
        const okShare = main ? okShareOf(c, main.host, main.path) : null;
        const sc = scoreRule(st, okShare);
        if (sc.mitigated < MIN_EVENTS || sc.score < FP_SCORE) continue;
        const row = eff(c).eff.rules.find((r) => r.ruleId === st.ruleId && r.kind === st.kind);
        const name = row?.name ?? st.description ?? st.ruleId;
        const draft = draftException({ ruleId: st.ruleId, rulesetId: st.rulesetId, source: st.source, description: st.description, rulesetName: MANAGED_RULESETS[st.rulesetId], host: main?.host ?? '', path: main?.path ?? '/', pathShare: sc.pathShare }, paths.map((p) => p.path));
        out.push({ resource: `${st.source}:${st.ruleId}`, verdict: 'needs_validation', severity: 'medium', title: `${KIND_LABEL[st.kind]} “${name}” looks like it stops real visitors (score ${sc.score}/100)`,
          description: `${winText(c.s)} it blocked or challenged ${n.format(sc.mitigated)} requests. Signals: ${sc.signals.filter((x) => x.points > 0).map((x) => `${x.label} (${x.detail})`).join('; ')}.`,
          rootCause: 'The rule matches traffic that has the marks of ordinary visitors.', intendedBehavior: 'Rules stop attackers and let real visitors through.',
          evidence: [ev(evSrc, 'mitigated', sc.mitigated), ev(evSrc, 'challenges issued / solved', `${sc.challenged} / ${sc.solved}`), ev(evSrc, 'residential share', pct(sc.residentialShare)), ev(evSrc, 'browser share', pct(sc.browserShare)),
            ...(okShare !== null ? [ev(rqSrc, `2xx/3xx share on ${main!.path}`, pct(okShare))] : []), ev('window', 'hours', c.s.hours ?? 0)],
          fix: [`${draft.where}.`, `Expression: ${draft.expression}`, `Action: ${draft.action}${Object.keys(draft.actionParameters).length ? ` ${JSON.stringify(draft.actionParameters)}` : ''}`, ...draft.notes],
          validation: 'Look at a sample of the rule\'s events in Security › Events: real browsers on real pages (and solved challenges) mean false positives; one client or scripted user agents mean the rule is right.' });
      }
      return out.slice(0, 25);
    },
  },
  {
    ...T, id: 'traffic.managed_log', title: 'Managed rules that mostly only log', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['events'], passed: `No managed ruleset had ${pct(MANAGED_LOG_SHARE)}+ of ${MANAGED_LOG_MIN}+ events only logged.`,
    check: (c) => {
      const per = new Map<string, { log: number; total: number }>();
      for (const [, st] of eff(c).stats) {
        if (st.kind !== 'managed') continue;
        const x = per.get(st.rulesetId) ?? { log: 0, total: 0 };
        for (const [a, v] of Object.entries(st.actions)) { x.total += v; if (normAction(a) === 'log') x.log += v; }
        per.set(st.rulesetId, x);
      }
      return [...per].filter(([, x]) => x.total >= MANAGED_LOG_MIN && x.log / x.total >= MANAGED_LOG_SHARE).map(([id, x]) => ({
        resource: id, verdict: 'confirmed' as Verdict, severity: 'medium' as const, title: `${MANAGED_RULESETS[id] ?? `Managed ruleset ${id}`}: ${pct(x.log / x.total)} of its matches were only logged`,
        description: `${winText(c.s)} it matched ${n.format(x.total)} requests and acted on ${n.format(x.total - x.log)}; the rest reached the origin.`,
        rootCause: 'The ruleset (or most of its rules) is overridden to Log.', intendedBehavior: 'Managed rules act with their default actions, with exceptions only for proven false positives.',
        evidence: [ev(evSrc, 'logged', x.log), ev(evSrc, 'all events', x.total), ev('window', 'hours', c.s.hours ?? 0)],
        fix: ['Security › WAF › Managed rules › the ruleset › Configure: set the ruleset action back to Default; add exceptions for the specific rules that cause false positives instead.'],
      }));
    },
  },
  {
    ...T, id: 'traffic.ratelimit_unused', title: 'Rate limits that never trigger on busy paths', attackClass: 'Pre-authentication work imbalance', skillRef: RES,
    needs: ['events', 'requests', 'phase:http_ratelimit'], passed: `No rate limiting rule stayed silent while its paths got ${n.format(RL_HEAVY)}+ requests.`,
    check: (c) => {
      const out: Draft[] = [];
      for (const r of c.v<RulesetRule[]>('phase:http_ratelimit') ?? []) {
        if (r.enabled === false || !r.id) continue;
        if (eff(c).eff.rules.some((x) => x.ruleId === r.id && x.events > 0)) continue;
        const lits = literalPaths(r.expression);
        if (!lits.length) continue;
        const hits = reqs(c).paths.filter((p) => lits.some((l) => pathMatches(p.path, l))).reduce((a, p) => a + p.count, 0);
        if (hits < RL_HEAVY) continue;
        const rl = (r.ratelimit ?? {}) as Record<string, unknown>;
        out.push({ resource: r.id, verdict: 'needs_validation', severity: 'low', title: `Rate limit “${r.description || r.id}” never triggered while its paths got ${n.format(hits)} requests`,
          description: `${winText(c.s)} the paths it covers (${lits.map((l) => l.path).join(', ')}) received ${n.format(hits)} requests and the rule acted on none. The threshold may be higher than any client ever reaches.`,
          rootCause: 'The threshold or counting characteristic is too generous for the traffic.', intendedBehavior: 'A rate limit sits above legitimate peaks and below abusive rates.',
          evidence: [ev(rqSrc, 'requests on the paths', hits), ev(evSrc, 'rate limit events', 0), ev('GET /zones/{id}/rulesets/phases/http_ratelimit/entrypoint', `${r.description || r.id}.ratelimit`, JSON.stringify(rl)), ev('window', 'hours', c.s.hours ?? 0)],
          fix: [`Security › WAF › Rate limiting rules › “${r.description || r.id}”: lower requests_per_period (now ${rl.requests_per_period ?? '?'} per ${rl.period ?? '?'}s), first with action Log to see who would be limited.`],
          validation: 'Check the busiest clients on those paths in Security › Analytics: if the top IP stays well under the threshold, the rule cannot trigger.' });
      }
      return out;
    },
  },
  {
    ...T, id: 'traffic.unmitigated_paths', title: 'Busy failing paths no rule acts on', attackClass: 'Pre-authentication work imbalance', skillRef: RES,
    needs: ['events', 'requests'], passed: `No path with ${n.format(HOT_MIN)}+ requests and ${pct(HOT_4XX)}+ 4xx went without mitigation.`,
    check: (c) => {
      const agg = new Map<string, { host: string; path: string; total: number; c4: number }>();
      for (const p of reqs(c).paths) {
        const k = `${p.host}${p.path}`;
        const x = agg.get(k) ?? { host: p.host, path: p.path, total: 0, c4: 0 };
        x.total += p.count; if (p.status >= 400 && p.status < 500) x.c4 += p.count;
        agg.set(k, x);
      }
      const out: Draft[] = [];
      for (const x of [...agg.values()].sort((a, b) => b.total - a.total)) {
        if (x.total < HOT_MIN || x.c4 / x.total < HOT_4XX) continue;
        const mit = mitigatedOnPath(c, x.host, x.path);
        if (mit / x.total >= HOT_MITIGATED_MAX) continue;
        const expr = `(http.host eq ${ruleString(x.host)} and http.request.uri.path eq ${ruleString(x.path)})`;
        out.push({ resource: `${x.host}${x.path}`, verdict: 'needs_validation', severity: 'medium', title: `${x.host}${x.path}: ${n.format(x.total)} requests, ${pct(x.c4 / x.total)} failing, and no rule acting`,
          description: `${winText(c.s)} this path answered 4xx to most requests (probing, credential stuffing or a broken client) and security mitigated ${n.format(mit)} of them.`,
          rootCause: 'No rule covers a path that draws a high volume of failing requests.', intendedBehavior: 'Paths under sustained failing traffic are rate limited or challenged.',
          evidence: [ev(rqSrc, 'requests', x.total), ev(rqSrc, '4xx', x.c4), ev(evSrc, 'mitigated on the path', mit), ev('window', 'hours', c.s.hours ?? 0)],
          fix: [`Candidate rate limiting rule (Security › WAF › Rate limiting rules › Create): expression ${expr}, counting by IP, e.g. 10 requests per minute, action Managed Challenge — start with Log.`, `Or a custom rule with the same expression and action Managed Challenge.`],
          validation: 'Look at the 4xx requests to this path in Security › Analytics: many clients each failing a few times is credential stuffing or scanning (add the rule); one broken integration is better fixed at its source.' });
        if (out.length >= 10) break;
      }
      return out;
    },
  },
  {
    ...T, id: 'traffic.unmitigated_networks', title: 'Hosting networks with failing traffic and no rule acting', attackClass: 'Pre-authentication work imbalance', skillRef: RES,
    needs: ['events', 'requests'], passed: `No hosting network with ${pct(HOT_ASN_SHARE)}+ of requests and ${pct(HOT_4XX)}+ 4xx went without mitigation.`,
    check: (c) => {
      const agg = new Map<string, { asn: string; name: string; total: number; c4: number }>();
      let all = 0;
      for (const a of reqs(c).asns) {
        all += a.count;
        const x = agg.get(a.asn) ?? { asn: a.asn, name: a.name, total: 0, c4: 0 };
        x.total += a.count; if (a.status >= 400 && a.status < 500) x.c4 += a.count;
        agg.set(a.asn, x);
      }
      const mitByAsn = new Map<string, number>();
      for (const a of c.v<EventData>('events').asns) if (mitigating(a.action)) mitByAsn.set(a.asn, (mitByAsn.get(a.asn) ?? 0) + a.count);
      const out: Draft[] = [];
      for (const x of [...agg.values()].sort((a, b) => b.total - a.total)) {
        if (!all || x.total < HOT_MIN || x.total / all < HOT_ASN_SHARE || x.c4 / x.total < HOT_4XX || !isHostingAsn(x.name)) continue;
        const mit = mitByAsn.get(x.asn) ?? 0;
        if (mit / x.total >= HOT_MITIGATED_MAX) continue;
        out.push({ resource: `AS${x.asn}`, verdict: 'needs_validation', severity: 'medium', title: `AS${x.asn} (${x.name}): ${pct(x.total / all)} of requests, ${pct(x.c4 / x.total)} failing, no rule acting`,
          description: `${winText(c.s)} a hosting network sent ${n.format(x.total)} requests, most answered 4xx, and security mitigated ${n.format(mit)}.`,
          rootCause: 'No rule addresses a hosting network that sends a large volume of failing requests.', intendedBehavior: 'Automated traffic from hosting networks is challenged unless it is a known integration.',
          evidence: [ev(rqSrc, `AS${x.asn} requests`, x.total), ev(rqSrc, `AS${x.asn} 4xx`, x.c4), ev(rqSrc, 'all requests', all), ev(evSrc, `AS${x.asn} mitigated`, mit), ev('window', 'hours', c.s.hours ?? 0)],
          fix: [`Candidate custom rule (Security › WAF › Custom rules › Create): expression (ip.src.asnum eq ${x.asn} and not cf.client.bot), action Managed Challenge — check first that none of your own services or partners run in this network.`],
          validation: `Check whether your own monitoring, API partners or CI run in AS${x.asn}; if not, the traffic is unwanted automation.` });
        if (out.length >= 5) break;
      }
      return out;
    },
  },
];

/** The reason traffic was not read, for the report (null when it was). */
export function trafficNote(s: Snapshot): string | null {
  const g = s.reads.events;
  if (!g) return 'Security events were not read';
  return g.state === 'ok' ? null : g.reason;
}
