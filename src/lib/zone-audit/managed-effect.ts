// Managed rulesets as a whole: each ruleset's deployment state, overrides, OWASP tuning and
// exceptions (from the configuration), what each did in the window (from the security events), and
// two traffic rules — Cloudflare Managed Ruleset and OWASP effectiveness. Pure.
//
// What the events can and cannot show: Cloudflare logs each managed rule that acted on a request
// with its rule and ruleset id and the action. The OWASP anomaly score of a request is not a field
// of the security-event datasets (Cloudflare documents none), so the audit does not estimate how
// many requests other thresholds or paranoia levels would block; it reports what 949110 did, the
// individual OWASP rules the events name (if any), and the false-positive signals on what it blocked.

import { OWASP_ANOMALY_RULE, OWASP_RULESET } from '../traffic-types';
import { MIN_EVENTS, draftException, normAction, scoreRule } from '../waf-fp-score';
import { effectivenessOf, FP_SCORE, ZERO_CONFIRM_HOURS } from './effectiveness';
import { norm } from './expr';
import { CF_MANAGED, CLOUD, DDOS_L7, ATTACK, PAID, active, ap, ev, executes, obj, phasePath, ruleName, rulesOf, type Draft, type RuleDef } from './rules';
import { EXPOSED_CREDENTIALS, FREE_MANAGED, OWASP_DEFAULT_THRESHOLD, SENSITIVE_DATA } from './rules-extra';
import { windowLabel, type EventData, type ManagedException, type ManagedOverview, type ManagedRulesetState, type RulesetRule, type Snapshot, type ZoneInfo } from './types';
import { compactNum } from '@/lib/num';

/** The managed rulesets the overview lists: id, name, phase and the plans that offer it (null: every plan). */
export const MANAGED_SETS: { id: string; name: string; phase: 'http_request_firewall_managed' | 'http_response_firewall_managed' | 'ddos_l7'; plans: string[] | null }[] = [
  { id: CF_MANAGED, name: 'Cloudflare Managed Ruleset', phase: 'http_request_firewall_managed', plans: PAID },
  { id: OWASP_RULESET, name: 'Cloudflare OWASP Core Ruleset', phase: 'http_request_firewall_managed', plans: PAID },
  { id: FREE_MANAGED, name: 'Cloudflare Free Managed Ruleset', phase: 'http_request_firewall_managed', plans: null },
  { id: EXPOSED_CREDENTIALS, name: 'Exposed Credentials Check (deprecated)', phase: 'http_request_firewall_managed', plans: PAID },
  { id: SENSITIVE_DATA, name: 'Sensitive Data Detection', phase: 'http_response_firewall_managed', plans: ['enterprise'] },
  { id: DDOS_L7, name: 'HTTP DDoS attack protection', phase: 'ddos_l7', plans: null },
];
/** Top managed rules listed per ruleset. */
export const TOP_MANAGED_RULES = 10;
/** Managed rules that matched only in log, listed when at least this many requests. */
export const LOG_ONLY_MIN = 10;
/** OWASP flagged traffic but blocked none: at least this many logged anomaly matches. */
export const OWASP_LOG_MIN = 100;

const list = (v: unknown) => (Array.isArray(v) ? v.map(obj) : []);
const sumOf = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const isLog = (a: string) => normAction(a) === 'log';

function eventsOf(d: EventData | null, rulesetId: string): ManagedRulesetState['events'] {
  if (!d) return null;
  const byAction: Record<string, number> = {};
  const rules = new Map<string, { ruleId: string; description: string; total: number; byAction: Record<string, number>; logOnly: boolean }>();
  for (const r of d.rules) {
    if (r.rulesetId !== rulesetId) continue;
    byAction[r.action] = (byAction[r.action] ?? 0) + r.count;
    const x = rules.get(r.ruleId) ?? { ruleId: r.ruleId, description: r.description, total: 0, byAction: {}, logOnly: true };
    x.total += r.count; x.byAction[r.action] = (x.byAction[r.action] ?? 0) + r.count; if (!isLog(r.action)) x.logOnly = false;
    if (!x.description) x.description = r.description;
    rules.set(r.ruleId, x);
  }
  return { total: sumOf(byAction), byAction, topRules: [...rules.values()].sort((a, b) => b.total - a.total || a.ruleId.localeCompare(b.ruleId)).slice(0, TOP_MANAGED_RULES) };
}

/** The Managed Ruleset tab: every managed ruleset, its overrides and events, and the exceptions with their traffic. */
const cache = new WeakMap<Snapshot, ManagedOverview>();
export function managedOverview(s: Snapshot): ManagedOverview {
  const hit = cache.get(s);
  if (hit) return hit;
  const out = build(s);
  cache.set(s, out);
  return out;
}
function build(s: Snapshot): ManagedOverview {
  const zone = s.reads.zone?.state === 'ok' ? s.reads.zone.value as ZoneInfo : null;
  const d = s.reads.events?.state === 'ok' ? s.reads.events.value as EventData : null;
  const phase = (p: string) => s.reads[`phase:${p}` as 'phase:ddos_l7'];
  const rulesets: ManagedRulesetState[] = MANAGED_SETS.map((m) => {
    const base = { id: m.id, name: m.name, phase: m.phase, overrides: [] as ManagedRulesetState['overrides'], events: eventsOf(d, m.id) };
    if (m.plans && zone && !m.plans.includes(zone.plan)) return { ...base, state: 'not_applicable', reason: `Not offered on the ${zone.plan} plan` };
    const g = phase(m.phase);
    if (!g || g.state === 'error') return { ...base, state: 'not_read', reason: g?.state === 'error' ? g.reason : 'not read' };
    if (g.state === 'absent') return { ...base, state: 'not_applicable', reason: g.reason };
    const deps = executes(g.value as RulesetRule[], m.id);
    // HTTP DDoS protection always runs; its entrypoint only holds overrides.
    if (!deps.length) return m.id === DDOS_L7 ? { ...base, state: 'deployed', scope: 'true', reason: 'Always on (no overrides)' } : { ...base, state: 'not_deployed' };
    const on = deps.filter(active);
    const dep = on[0] ?? deps[0];
    const o = obj(ap(dep).overrides);
    const overrides: ManagedRulesetState['overrides'] = [
      ...list(o.categories).filter((x) => x.enabled === false || typeof x.action === 'string').map((x) => ({ kind: 'category' as const, id: String(x.category), change: x.enabled === false ? 'disabled' : `action ${String(x.action)}` })),
      ...list(o.rules).filter((x) => x.enabled === false || typeof x.action === 'string' || x.score_threshold !== undefined || x.sensitivity_level !== undefined)
        .map((x) => ({ kind: 'rule' as const, id: String(x.id), change: [x.enabled === false ? 'disabled' : '', typeof x.action === 'string' ? `action ${String(x.action)}` : '', x.score_threshold !== undefined ? `threshold ${String(x.score_threshold)}` : '', x.sensitivity_level !== undefined ? `sensitivity ${String(x.sensitivity_level)}` : ''].filter(Boolean).join(', ') })),
    ];
    const state: ManagedRulesetState = { ...base, state: on.length && o.enabled !== false ? 'deployed' : 'disabled', scope: norm(dep.expression) || 'true', action: typeof o.action === 'string' ? o.action : null, overrides };
    if (m.id === OWASP_RULESET) {
      const anomaly = list(o.rules).find((x) => String(x.id) === OWASP_ANOMALY_RULE);
      const plOff = list(o.categories).filter((x) => /^paranoia-level-\d$/.test(String(x.category)) && x.enabled === false).map((x) => Number(String(x.category).slice(-1)));
      state.paranoia = plOff.length ? Math.min(...plOff) - 1 : null;
      state.threshold = Number(anomaly?.score_threshold ?? OWASP_DEFAULT_THRESHOLD);
    }
    return state;
  });
  const mg = phase('http_request_firewall_managed');
  const rules = mg?.state === 'ok' ? mg.value as RulesetRule[] : [];
  const lastExec = rules.reduce((a, r, i) => (r.action === 'execute' && active(r) ? i : a), -1);
  const eff = effectivenessOf(s);
  const exceptions: ManagedException[] = rules.flatMap((r, i): ManagedException[] => {
    if (r.action !== 'skip') return [];
    const p = ap(r);
    const sets = Array.isArray(p.rulesets) ? p.rulesets.map((x) => MANAGED_SETS.find((m) => m.id === x)?.name ?? String(x)) : [];
    const ruleCount = Object.values(obj(p.rules)).reduce((a: number, v) => a + (Array.isArray(v) ? v.length : 0), 0);
    const row = eff?.eff.rules.find((x) => x.ruleId === r.id && x.kind === 'managed') ?? null;
    return [{ id: r.id ?? String(i), name: ruleName(r), expression: r.expression ?? '', enabled: active(r), position: i > lastExec ? 'after' : 'before',
      skips: p.ruleset === 'current' ? 'all remaining managed rules' : sets.length ? sets.join(', ') : `${ruleCount} managed rule${ruleCount === 1 ? '' : 's'}`,
      skipped: eff ? Object.entries(row?.byAction ?? {}).filter(([a]) => normAction(a) === 'skip').reduce((t, [, v]) => t + v, 0) : null,
      verdict: row?.passthrough?.verdict ?? null, effectKey: row?.key ?? null }];
  });
  const lc = s.reads.leaked_credentials;
  return { rulesets, exceptions, leakedCredentials: lc?.state === 'ok' ? ((lc.value as { enabled?: boolean })?.enabled ? 'on' : 'off') : 'not_read' };
}

const evSrc = 'GraphQL firewallEventsAdaptiveGroups';
const T = { group: 'traffic' as const };
import { whole as n } from '@/lib/num';
const pct = (x: number) => `${Math.round(x * 100)}%`;
const win = (s: Snapshot) => `in the last ${windowLabel(s.hours ?? 0)}`;

export const MANAGED_TRAFFIC_RULES: RuleDef[] = [
  {
    ...T, id: 'traffic.managed_effect', title: 'Managed rulesets in the traffic', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['events', 'phase:http_request_firewall_managed', 'zone'], passed: 'Every deployed managed ruleset matched traffic, and no managed rule matched only in log.',
    check: (c) => {
      const o = managedOverview(c.s);
      const out: Draft[] = [];
      for (const m of o.rulesets) {
        if (m.state !== 'deployed' || m.phase !== 'http_request_firewall_managed' || !m.events) continue;
        if (!m.events.total) out.push({ resource: `${m.id}:zero`, verdict: (c.s.hours ?? 0) >= ZERO_CONFIRM_HOURS ? 'confirmed' : 'needs_validation', severity: 'info', title: `${m.name} matched nothing ${win(c.s)}`,
          description: 'Normal on a quiet zone; on a busy one it can mean the deploy expression excludes the traffic.', rootCause: 'No security event names this ruleset in the window.', intendedBehavior: 'The ruleset inspects all traffic.',
          evidence: [ev(evSrc, `events for ruleset ${m.id}`, 0), ev(phasePath('http_request_firewall_managed'), 'deploy expression', m.scope ?? '')], fix: ['No change needed if the zone is quiet; otherwise check the deploy rule\'s expression (Security › WAF › Managed rules › Edit scope).'],
          validation: 'Compare with the zone\'s request volume: a busy zone with no managed-rule matches in a week is unusual.' });
        const logOnly = m.events.topRules.filter((r) => r.logOnly && r.total >= LOG_ONLY_MIN && r.ruleId !== OWASP_ANOMALY_RULE);
        if (logOnly.length) out.push({ resource: `${m.id}:log`, verdict: 'confirmed', severity: 'low', title: `${logOnly.length} ${m.name} rule${logOnly.length === 1 ? '' : 's'} matched only in log (${n.format(logOnly.reduce((a, r) => a + r.total, 0))} requests)`,
          description: `These rules are overridden to log, so what they matched reached the origin: ${logOnly.map((r) => `${r.ruleId}${r.description ? ` (${r.description})` : ''}: ${n.format(r.total)}`).join('; ')}. Each one's traffic is broken down in Effectiveness.`,
          rootCause: 'Rule or category overrides set to Log.', intendedBehavior: 'Managed rules act with their default action unless they cause false positives.', evidence: logOnly.map((r) => ev(evSrc, `rule ${r.ruleId}`, `${compactNum(r.total)} logged`)),
          fix: ['Security › WAF › Managed rules › the ruleset › Browse rules: for each rule above, remove the Log override (back to Default) — unless Effectiveness shows its matches are legitimate traffic, then keep it and add a narrow exception instead.'] });
      }
      return out;
    },
  },
  {
    ...T, id: 'traffic.owasp_effect', title: 'OWASP Core Ruleset in the traffic', attackClass: 'Injection', skillRef: ATTACK,
    needs: ['events', 'phase:http_request_firewall_managed', 'zone'], plans: PAID, passed: 'OWASP blocks what it flags, and what it blocks does not look like real visitors.',
    check: (c) => {
      const deps = executes(rulesOf(c, 'http_request_firewall_managed'), OWASP_RULESET).filter(active);
      if (!deps.length) return { notApplicable: 'The OWASP Core Ruleset is not deployed (see waf.owasp)' };
      const e = effectivenessOf(c.s)!;
      const st = [...e.stats.values()].find((x) => x.rulesetId === OWASP_RULESET && x.ruleId === OWASP_ANOMALY_RULE);
      const out: Draft[] = [];
      const logged = Object.entries(st?.actions ?? {}).filter(([a]) => normAction(a) === 'log').reduce((t, [, v]) => t + v, 0);
      const acted = Object.entries(st?.actions ?? {}).filter(([a]) => !['log', 'skip', 'allow'].includes(normAction(a))).reduce((t, [, v]) => t + v, 0);
      const ev949 = ev(evSrc, 'rule 949110 (Inbound Anomaly Score Exceeded)', `${compactNum(acted)} blocked or challenged, ${compactNum(logged)} logged`);
      if (logged >= OWASP_LOG_MIN && !acted) out.push({ resource: 'log-only', verdict: 'confirmed', severity: 'medium', title: `OWASP flagged ${n.format(logged)} requests ${win(c.s)} and blocked none`,
        description: 'Requests over the anomaly threshold were only logged, so they reached the origin. Effectiveness breaks down what they were (bots, attack scores, threat paths).', rootCause: 'The OWASP deploy rule (or rule 949110) is overridden to Log.',
        intendedBehavior: 'Requests over the threshold are blocked.', evidence: [ev949, ev('window', 'hours', c.s.hours ?? 0)],
        fix: ['Security › WAF › Managed rules › OWASP Core Ruleset › Configure: set the action of "Inbound Anomaly Score Exceeded" to Block (or Managed Challenge first).'] });
      if (st && acted >= MIN_EVENTS) {
        const paths = [...st.paths].sort((a, b) => b.count - a.count);
        const sc = scoreRule(st, null);
        if (sc.score >= FP_SCORE) {
          const threshold = Number(list(obj(ap(deps[0]).overrides).rules).find((x) => String(x.id) === OWASP_ANOMALY_RULE)?.score_threshold ?? OWASP_DEFAULT_THRESHOLD);
          const next = threshold < 40 ? 40 : threshold < 60 ? 60 : null;
          const draft = draftException({ ruleId: OWASP_ANOMALY_RULE, rulesetId: OWASP_RULESET, source: 'firewallManaged', description: '949110', rulesetName: 'OWASP Core Ruleset', host: paths[0]?.host ?? '', path: paths[0]?.path ?? '/', pathShare: sc.pathShare }, paths.map((p) => p.path));
          out.push({ resource: 'fp', verdict: 'needs_validation', severity: 'medium', title: `OWASP may be blocking real visitors (score ${sc.score}/100 on ${n.format(acted)} requests)`,
            description: `Signals on what 949110 blocked or challenged: ${sc.signals.filter((x) => x.points > 0).map((x) => `${x.label} (${x.detail})`).join('; ')}.`,
            rootCause: 'The anomaly threshold is reached by requests with the marks of ordinary visitors.', intendedBehavior: 'OWASP stops attacks without stopping customers.',
            evidence: [ev949, ev(evSrc, 'residential share', pct(sc.residentialShare)), ev(evSrc, 'browser share', pct(sc.browserShare)), ...paths.slice(0, 3).map((p) => ev(evSrc, `path ${p.path}`, p.count))],
            fix: [`Prefer an exception for the affected path: ${draft.where}; expression ${draft.expression}; skip rule 949110 of the OWASP ruleset only.`,
              ...(next ? [`Or raise the anomaly score threshold from ${threshold} to ${next} (Configure › Score threshold) — this weakens OWASP for every path.`] : [])],
            validation: 'Sample the blocked requests in Security › Events (filter: rule 949110): form posts, rich-text or JSON bodies from browsers point to false positives; scanners and payloads point to real attacks.' });
        }
      }
      return out;
    },
  },
];

