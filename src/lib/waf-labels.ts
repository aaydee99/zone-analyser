// Plain-language names for security event sources and actions, and how a managed ruleset is
// deployed: its ruleset action and status, and for OWASP its anomaly score threshold, paranoia level
// and action. Pure (no Node imports): shared by the Zone explorer, Traffic analytics, the WAF
// false-positive finder and the downloads.
//
// OWASP tuning (Cloudflare docs, "OWASP Core Ruleset › Concepts" and "Configure via API"): PL1 by
// default; a level is set by turning off the paranoia-level-N categories above it (PL2: 3 and 4 off).
// The threshold is the score_threshold of rule 949110 "Inbound Anomaly Score Exceeded": 60 and higher
// low, 40 medium (default), 25 high sensitivity. Its action is Block unless overridden, on that rule
// or for the whole ruleset.

import { MANAGED_RULESETS, OWASP_ANOMALY_RULE, OWASP_RULESET } from './traffic-types';

export const SOURCE: Record<string, string> = {
  firewallManaged: 'Managed rules', firewallCustom: 'Custom rules', firewallRules: 'Firewall rules (legacy)', ratelimit: 'Rate limiting rules',
  waf: 'WAF (legacy managed rules)', l7ddos: 'HTTP DDoS protection', bic: 'Browser integrity check', hot: 'Hotlink protection',
  securitylevel: 'Security level', uablock: 'User agent blocking', zonelockdown: 'Zone lockdown', ip: 'IP access rules', iprange: 'IP access rules',
  asn: 'IP access rules (ASN)', country: 'IP access rules (country)', botFight: 'Bot fight mode', botManagement: 'Bot management',
  superBotFight: 'Super bot fight mode', validation: 'Request validation', apiShield: 'API Shield', apiShieldSchemaValidation: 'API Shield schema validation',
  apiShieldTokenValidation: 'API Shield JWT validation', apiShieldSequenceMitigation: 'API Shield sequence mitigation', dlp: 'Data loss prevention',
  sanitycheck: 'Sanity check', firewallrules: 'Firewall rules (legacy)', 'l7ddos-managed': 'HTTP DDoS protection', linkMaze: 'AI Labyrinth',
};
export const sourceLabel = (s: string) => SOURCE[s] ?? (s || 'Unknown');

export const ACTION_LABEL: Record<string, string> = {
  block: 'Block', drop: 'Drop', challenge: 'Interactive challenge', jschallenge: 'JS challenge', js_challenge: 'JS challenge', managed_challenge: 'Managed challenge',
  challenge_solved: 'Challenge solved', challenge_failed: 'Challenge failed', challenge_bypassed: 'Challenge bypassed', jschallenge_solved: 'JS challenge solved',
  jschallenge_failed: 'JS challenge failed', jschallenge_bypassed: 'JS challenge bypassed', managed_challenge_skipped: 'Managed challenge skipped',
  managed_challenge_non_interactive_solved: 'Managed challenge solved', managed_challenge_interactive_solved: 'Managed challenge solved (interactive)',
  managed_challenge_bypassed: 'Managed challenge bypassed', log: 'Log', allow: 'Allow', bypass: 'Bypass', skip: 'Skip', connection_close: 'Close connection',
  rewrite: 'Rewrite', redirect: 'Redirect', unknown: 'Unknown', execute: 'Run ruleset',
};
export const actionLabel = (a: string) => ACTION_LABEL[a] ?? (a || 'Unknown');

// ── Managed ruleset deployments ─────────────────────────────────────────────

/** A rule that runs a ruleset (action execute), with its overrides (Rulesets API: action_parameters.overrides). */
export interface Deploy {
  rulesetId: string;
  /** The deploy rule itself is on. */
  enabled: boolean;
  /** Ruleset action: one action for every rule (overrides.action). */
  action?: string;
  /** Ruleset status: every rule on (true) or off (false) (overrides.enabled). */
  rulesEnabled?: boolean;
  categories: { category: string; enabled?: boolean; action?: string }[];
  rules: { id: string; enabled?: boolean; action?: string; scoreThreshold?: number }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const objs = (v: unknown) => (Array.isArray(v) ? v.filter(isObj) : []);

/** The rule as a deployment, when it runs a ruleset; null for any other rule. */
export function deployOf(r: Record<string, unknown>): Deploy | null {
  const p = isObj(r.action_parameters) ? r.action_parameters : {};
  if (r.action !== 'execute' || typeof p.id !== 'string') return null;
  const o = isObj(p.overrides) ? p.overrides : {};
  return {
    rulesetId: p.id, enabled: r.enabled !== false,
    ...(typeof o.action === 'string' ? { action: o.action } : {}),
    ...(typeof o.enabled === 'boolean' ? { rulesEnabled: o.enabled } : {}),
    categories: objs(o.categories).filter((c) => typeof c.category === 'string').map((c) => ({ category: String(c.category),
      ...(typeof c.enabled === 'boolean' ? { enabled: c.enabled } : {}), ...(typeof c.action === 'string' ? { action: c.action } : {}) })),
    rules: objs(o.rules).filter((x) => typeof x.id === 'string').map((x) => ({ id: String(x.id),
      ...(typeof x.enabled === 'boolean' ? { enabled: x.enabled } : {}), ...(typeof x.action === 'string' ? { action: x.action } : {}),
      ...(typeof x.score_threshold === 'number' ? { scoreThreshold: x.score_threshold } : {}) })),
  };
}

/** A deployment as Traffic analytics reads it (traffic-security.ts readManaged). */
export const deployOfManaged = (m: { rulesetId: string; enabled: boolean; action?: string; rulesEnabled?: boolean; categoryOverrides: Deploy['categories']; ruleOverrides: Deploy['rules'] }): Deploy => ({
  rulesetId: m.rulesetId, enabled: m.enabled, ...(m.action ? { action: m.action } : {}), ...(m.rulesEnabled !== undefined ? { rulesEnabled: m.rulesEnabled } : {}),
  categories: m.categoryOverrides, rules: m.ruleOverrides,
});

export const OWASP_DEFAULT_THRESHOLD = 40;
const PL = /^paranoia-level-(\d)$/;

/** The OWASP paranoia level: below the lowest paranoia-level category turned off, else the highest turned on, else PL1 (the default). */
export function paranoiaOf(categories: Deploy['categories']): { level: number; set: boolean } {
  const lvl = (c: { category: string }) => Number(PL.exec(c.category)?.[1] ?? 0);
  const off = categories.filter((c) => lvl(c) && c.enabled === false).map(lvl);
  if (off.length) return { level: Math.max(1, Math.min(...off) - 1), set: true };
  const on = categories.filter((c) => lvl(c) && c.enabled === true).map(lvl);
  return on.length ? { level: Math.max(...on), set: true } : { level: 1, set: false };
}

/** "Medium — 40 and higher": the dashboard's name for an anomaly score threshold. */
export const thresholdLabel = (t: number) => `${t >= 60 ? 'Low' : t >= 40 ? 'Medium' : 'High'} — ${t} and higher`;

export interface OwaspTuning {
  threshold: number; thresholdSet: boolean;
  paranoia: number; paranoiaSet: boolean;
  /** The action when the score reaches the threshold. */
  action: string; actionSet: boolean;
}

/** A deployment in the dashboard's terms: the ruleset's name, Ruleset action and Ruleset status, OWASP's tuning, and every other override. */
export interface DeployTuning {
  rulesetId: string;
  name: string;
  /** One of Cloudflare's managed rulesets (not an account custom ruleset). */
  managed: boolean;
  rulesetAction: string;
  rulesetStatus: string;
  owasp?: OwaspTuning;
  /** The other rule and category overrides, one line each. */
  overrides: string[];
}

const overrideText = (x: { enabled?: boolean; action?: string; scoreThreshold?: number }) =>
  [x.enabled === false ? 'off' : x.enabled === true ? 'on' : '', x.action ? `action ${actionLabel(x.action)}` : '', x.scoreThreshold !== undefined ? `threshold ${x.scoreThreshold}` : ''].filter(Boolean).join(' · ');

export function tuningOf(d: Deploy, names: Record<string, string> = {}): DeployTuning {
  const name = names[d.rulesetId] || MANAGED_RULESETS[d.rulesetId] || 'a custom ruleset';
  const isOwasp = d.rulesetId === OWASP_RULESET;
  const rulesetStatus = !d.enabled ? 'Off — the rule that deploys it is disabled'
    : d.rulesEnabled === true ? 'Enabled — every rule on' : d.rulesEnabled === false ? 'Disabled — every rule off unless turned on below' : 'Default — each rule as Cloudflare ships it';
  const rulesetAction = d.action ? actionLabel(d.action) : 'Default — each rule’s own action';
  const anomaly = isOwasp ? d.rules.find((x) => x.id === OWASP_ANOMALY_RULE) : undefined;
  let owasp: OwaspTuning | undefined;
  if (isOwasp) {
    const pl = paranoiaOf(d.categories);
    const action = anomaly?.action ?? d.action;
    owasp = { threshold: anomaly?.scoreThreshold ?? OWASP_DEFAULT_THRESHOLD, thresholdSet: anomaly?.scoreThreshold !== undefined,
      paranoia: pl.level, paranoiaSet: pl.set, action: action ?? 'block', actionSet: !!action };
  }
  const overrides = [
    ...d.categories.filter((c) => !(isOwasp && PL.test(c.category))).map((c) => `Category “${c.category}”: ${overrideText(c) || 'no change'}`),
    ...d.rules.filter((x) => x !== anomaly || x.enabled !== undefined).map((x) => `Rule ${x.id}${x === anomaly ? ' (949110 Inbound Anomaly Score Exceeded)' : ''}: ${overrideText(x === anomaly ? { enabled: x.enabled } : x) || 'no change'}`),
  ];
  return { rulesetId: d.rulesetId, name, managed: d.rulesetId in MANAGED_RULESETS || /managed|owasp|credential/i.test(name), rulesetAction, rulesetStatus, ...(owasp ? { owasp } : {}), overrides };
}

/** The deployment's settings as [label, value] pairs, in the dashboard's order. */
export function tuningLines(t: DeployTuning): [string, string][] {
  if (t.owasp) {
    const o = t.owasp;
    return [
      ['OWASP action', `${actionLabel(o.action)}${o.actionSet ? '' : ' (default)'}`],
      ['Anomaly score threshold', `${thresholdLabel(o.threshold)}${o.thresholdSet ? '' : ' (default)'}`],
      ['Paranoia level', `PL${o.paranoia}${o.paranoiaSet ? '' : ' (default)'}`],
      ['Ruleset status', t.rulesetStatus],
    ];
  }
  if (!t.managed) return [['Action', `Run ruleset${t.rulesetAction.startsWith('Default') ? '' : ` · ruleset action ${t.rulesetAction}`}`], ['Status', t.rulesetStatus]];
  return [['Ruleset action', t.rulesetAction], ['Ruleset status', t.rulesetStatus]];
}
