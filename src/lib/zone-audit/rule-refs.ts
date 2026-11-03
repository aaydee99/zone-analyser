// Which of the zone's Cloudflare rules a finding is about: a custom rule, a rate limiting rule, a
// managed or OWASP rule, a managed-rule exception, a managed ruleset… with its name. Pure.
//
// - ruleIndex: every rule the audit read (the ruleset phases, IP Access, Page Rules, Zone Lockdown and
//   User Agent Blocking rules) and every rule in the traffic table, by its Cloudflare ID and the key the
//   effectiveness table uses.
// - refsOf: a finding names the rule in its fingerprint (zone:<zone>:<check>:<resource>, the resource
//   being the rule's ID or traffic key, sometimes with a suffix such as ":action"); those are looked up.
//   Checks about a ruleset as a whole (the OWASP tuning, the Cloudflare Managed Ruleset's overrides…)
//   name the ruleset. A check about something missing (no rate limiting rule) names none.

import { MANAGED_RULESETS, OWASP_RULESET } from '../traffic-types';
import type { AuditFinding, Effectiveness, RuleEffect, RulesetRule, Snapshot } from './types';

export type RefKind = 'custom' | 'ratelimit' | 'managed' | 'owasp' | 'exception' | 'managed_ruleset' | 'owasp_ruleset' | 'config' | 'cache' | 'origin' | 'transform'
  | 'page' | 'access' | 'ddos' | 'bot' | 'lockdown' | 'ua' | 'other';
export const REF_LABEL: Record<RefKind, string> = {
  custom: 'Custom rule', ratelimit: 'Rate limiting rule', managed: 'Managed rule', owasp: 'OWASP rule', exception: 'Managed rule exception',
  managed_ruleset: 'Managed ruleset', owasp_ruleset: 'OWASP Core Ruleset', config: 'Configuration rule', cache: 'Cache rule', origin: 'Origin rule', transform: 'Transform rule',
  page: 'Page Rule', access: 'IP Access rule', ddos: 'HTTP DDoS override', bot: 'Bot protection', lockdown: 'Zone Lockdown rule', ua: 'User Agent Blocking rule', other: 'Security rule',
};

/** One rule a finding is about. `id` is Cloudflare's rule (or ruleset) ID; `detail` what it matches, for an IP Access rule ("Allow · IP 203.0.113.9"). */
export interface RuleRef { kind: RefKind; name: string; id?: string; detail?: string }

const ACCESS_MODE: Record<string, string> = { whitelist: 'Allow', block: 'Block', challenge: 'Challenge', js_challenge: 'JS challenge', managed_challenge: 'Managed challenge' };
const ACCESS_TARGET: Record<string, string> = { ip: 'IP', ip6: 'IPv6', ip_range: 'IP range', asn: 'ASN', country: 'Country' };
/** What an IP Access rule matches and does: "Allow · IP 203.0.113.9", "Block · Country NL". */
export function accessDetail(r: { mode?: string; configuration?: { target?: string; value?: string } }): string {
  const t = r.configuration?.target ?? '';
  const what = `${ACCESS_TARGET[t] ?? t} ${r.configuration?.value ?? ''}`.trim();
  return [r.mode ? ACCESS_MODE[r.mode] ?? r.mode : '', what].filter(Boolean).join(' · ');
}

export const CF_MANAGED_RULESET = 'efb7b8c949ac4650a09736fc376e9aee';
const rulesetName = (id: string) => (MANAGED_RULESETS[id] ?? 'Managed ruleset').replace(/^Cloudflare OWASP Core Ruleset$/, 'OWASP Core Ruleset');
const rulesetRef = (id: string): RuleRef => ({ kind: id === OWASP_RULESET ? 'owasp_ruleset' : 'managed_ruleset', name: rulesetName(id), id });
const named = (r: RulesetRule) => r.description?.trim() || r.ref || 'Unnamed rule';

/** The rule a row of the traffic table is. */
export function effectRef(e: Pick<RuleEffect, 'kind' | 'name' | 'ruleId' | 'rulesetId' | 'exception'>): RuleRef {
  const kind: RefKind = e.exception ? 'exception'
    : e.kind === 'managed' ? (e.rulesetId === OWASP_RULESET ? 'owasp' : 'managed')
      : e.kind === 'custom' ? 'custom' : e.kind === 'ratelimit' ? 'ratelimit' : e.kind === 'bot' ? 'bot' : e.kind === 'ddos' ? 'ddos' : e.kind === 'access' ? 'access' : 'other';
  return { kind, name: e.name || 'Unnamed rule', id: e.ruleId || undefined };
}

/** What a rule of a ruleset phase is (the managed phase: a deploy rule is its ruleset, a skip rule an exception). */
function phaseRef(phase: string, r: RulesetRule): RuleRef | null {
  const id = r.id;
  if (phase === 'http_request_firewall_managed') {
    if (r.action === 'execute') { const rs = String((r.action_parameters as { id?: unknown } | undefined)?.id ?? ''); return rs ? rulesetRef(rs) : { kind: 'managed_ruleset', name: named(r), id }; }
    if (r.action === 'skip') return { kind: 'exception', name: named(r), id };
    return { kind: 'managed', name: named(r), id };
  }
  const kind: RefKind | undefined = ({
    http_request_firewall_custom: 'custom', http_ratelimit: 'ratelimit', ddos_l7: 'ddos', http_request_cache_settings: 'cache', http_request_origin: 'origin',
    http_response_headers_transform: 'transform', http_request_late_transform: 'transform', http_config_settings: 'config', http_response_firewall_managed: 'managed',
  } as Record<string, RefKind>)[phase];
  return kind ? { kind, name: named(r), id } : null;
}

/** Every rule the audit read or saw in the traffic, by ID and by traffic key. */
export function ruleIndex(s: Snapshot | null, eff: Effectiveness | null): Map<string, RuleRef> {
  const idx = new Map<string, RuleRef>();
  const put = (key: string | undefined, ref: RuleRef | null) => { if (key && ref && !idx.has(key)) idx.set(key, ref); };
  for (const [id] of Object.entries(MANAGED_RULESETS)) put(id, rulesetRef(id));
  if (s) {
    for (const [key, got] of Object.entries(s.reads)) {
      if (!got || got.state !== 'ok') continue;
      const v = got.value;
      if (key.startsWith('phase:') && Array.isArray(v)) {
        const phase = key.slice(6);
        for (const r of v as RulesetRule[]) { const ref = phaseRef(phase, r); put(r.id, ref); put(r.ref, ref); }
      } else if ((key === 'access_rules' || key === 'account_access_rules') && Array.isArray(v)) {
        for (const r of v as { id: string; mode?: string; notes?: string; configuration?: { target?: string; value?: string } }[]) {
          const detail = accessDetail(r);
          put(r.id, { kind: 'access', name: r.notes?.trim() || detail || 'IP Access rule', id: r.id, detail });
        }
      } else if (key === 'page_rules' && Array.isArray(v)) {
        for (const p of v as { id: string; targets?: { constraint?: { value?: string } }[] }[]) put(p.id, { kind: 'page', name: p.targets?.[0]?.constraint?.value ?? 'Page Rule', id: p.id });
      } else if ((key === 'lockdowns' || key === 'ua_rules') && Array.isArray(v)) {
        for (const r of v as { id: string; description?: string }[]) put(r.id, { kind: key === 'lockdowns' ? 'lockdown' : 'ua', name: r.description?.trim() || 'Unnamed rule', id: r.id });
      }
    }
  }
  for (const e of eff?.rules ?? []) { const ref = (e.ruleId && idx.get(e.ruleId)) || effectRef(e); put(e.key, ref); put(e.ruleId, ref); }
  return idx;
}

/** Checks about a ruleset as a whole, when the fingerprint names none of its rules. */
const RULESET_OF: Record<string, string> = {
  'waf.managed_ruleset': CF_MANAGED_RULESET, 'managed.cf_overrides': CF_MANAGED_RULESET, 'waf.owasp': OWASP_RULESET, 'managed.owasp_tuning': OWASP_RULESET, 'traffic.owasp_effect': OWASP_RULESET,
};

/** The rules a finding is about (none for a check about something missing). */
export function refsOf(f: Pick<AuditFinding, 'fingerprint' | 'ruleId'> & { evidence?: AuditFinding['evidence'] }, idx: Map<string, RuleRef>): RuleRef[] {
  const resource = f.fingerprint.split(':').slice(3);
  const out: RuleRef[] = [];
  const add = (r: RuleRef | undefined) => { if (r && !out.some((x) => x.kind === r.kind && x.name === r.name && x.id === r.id)) out.push(r); };
  // The whole resource first (traffic keys hold colons), then each shorter prefix, then each part.
  for (let n = resource.length; n > 0 && !out.length; n--) add(idx.get(resource.slice(0, n).join(':')));
  if (!out.length) for (const part of resource) add(idx.get(part));
  // A check about several rules ("2 custom rules only log") names them in its evidence: an ID, or a field "<rule name>.<setting>".
  if (!out.length && f.evidence?.length) {
    const refs = [...new Set(idx.values())].filter((r) => !['managed_ruleset', 'owasp_ruleset'].includes(r.kind));
    for (const e of f.evidence) {
      for (const r of refs) if ((r.id && (e.field.includes(r.id) || String(e.value).includes(r.id))) || e.field === r.name || e.field.startsWith(`${r.name}.`)) add(r);
    }
  }
  if (!out.length && RULESET_OF[f.ruleId]) add(idx.get(RULESET_OF[f.ruleId]) ?? rulesetRef(RULESET_OF[f.ruleId]));
  return out;
}

/** "Custom rule “Watch API”", "OWASP Core Ruleset", "Rate limiting rule “Login”". */
export const refText = (r: RuleRef) => {
  const base = r.kind === 'owasp_ruleset' || (r.kind === 'managed_ruleset' && /Ruleset|Check|Detection/.test(r.name)) ? r.name : `${REF_LABEL[r.kind]} “${r.name}”`;
  return r.detail && r.detail !== r.name ? `${base} (${r.detail})` : base;
};
