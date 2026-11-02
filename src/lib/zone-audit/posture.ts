// The audit's posture summary: one plain-language answer to "how does this zone's security look",
// built only from the report (findings, coverage ledger, rule effectiveness), so it costs no extra
// Cloudflare call and works for audits stored before it existed. Pure.
//
// Its shape comes from the Cloudflare security skills reviewed for the audit:
// - the traffic-light scorecard with a one-line verdict (community "cloudflare-security" skill);
// - the attack categories, playbooks, plan feature matrix and "what to monitor" step
//   (cloudflare-security-analyst);
// - "not measured" kept apart from 0% when reading enforcement (waf-detector's posture rules).
//
// Every number is a fixed rule written below — nothing is guessed:
// - A finding costs its area PENALTY[severity] points out of 100, half when it needs validation.
// - An area is graded only when at least half of its applicable rules were read.
// - The grade is the weighted mean of the graded areas, capped at D by a confirmed critical finding
//   and at C by a confirmed high one.

import { actionItems } from './actions';
import { SEVERITY_RANK, byWorst, windowLabel, type AuditFinding, type AuditReport, type CoverageEntry, type RuleGroup, type Severity } from './types';
import { compactNum } from '../num';

export type Rating = 'strong' | 'fair' | 'weak' | 'at_risk' | 'unknown' | 'not_applicable';
export const RATING_LABEL: Record<Rating, string> = { strong: 'Strong', fair: 'Fair', weak: 'Weak', at_risk: 'At risk', unknown: 'Not graded', not_applicable: 'Not applicable' };

export const PENALTY: Record<Severity, number> = { critical: 40, high: 25, medium: 10, low: 3, info: 0 };
/** Grade floors (score out of 100). */
export const GRADES: { grade: string; min: number; label: string }[] = [
  { grade: 'A', min: 90, label: 'Strong' }, { grade: 'B', min: 80, label: 'Good' }, { grade: 'C', min: 70, label: 'Fair' }, { grade: 'D', min: 55, label: 'Weak' }, { grade: 'F', min: 0, label: 'At risk' },
];

export interface AreaDef { id: string; label: string; groups: RuleGroup[]; weight: number; what: string }
/** The scorecard's areas: which rule groups each covers and how much it weighs in the grade. */
export const AREAS: AreaDef[] = [
  { id: 'waf', label: 'Web application firewall', groups: ['managed', 'waf', 'bypass'], weight: 3, what: 'Managed and OWASP rules, custom rules, and rules that switch security off' },
  { id: 'traffic', label: 'Rules in practice', groups: ['traffic'], weight: 3, what: 'What the security rules did to the window\'s traffic' },
  { id: 'bots', label: 'Bots and automated abuse', groups: ['bots'], weight: 2, what: 'Bot Fight Mode, Super Bot Fight Mode, Bot Management, AI crawlers, Turnstile' },
  { id: 'availability', label: 'DDoS and rate limiting', groups: ['availability'], weight: 2, what: 'HTTP DDoS protection, rate limiting rules, development mode' },
  { id: 'access', label: 'Admin and login protection', groups: ['access'], weight: 2, what: 'Cloudflare Access or WAF rules in front of admin areas' },
  { id: 'transport', label: 'Encryption (TLS)', groups: ['transport'], weight: 2, what: 'SSL mode, TLS versions, HTTPS redirects, HSTS, certificates, origin pulls' },
  { id: 'origin', label: 'Origin and DNS', groups: ['origin', 'email'], weight: 2, what: 'Origin exposure, dangling records, SPF, DMARC, CAA, DNSSEC' },
  { id: 'cache', label: 'Cache and header trust', groups: ['cache', 'host'], weight: 1, what: 'Cache deception and poisoning, Host and client-IP header trust' },
  { id: 'client', label: 'Browser-side and edge', groups: ['client', 'edge'], weight: 1, what: 'Security headers, Page Shield, Worker routes' },
  { id: 'api', label: 'API protection', groups: ['api'], weight: 1, what: 'API Shield on zones whose traffic is mostly API' },
];

export interface AreaScore {
  id: string; label: string; what: string; weight: number;
  rating: Rating; score: number | null;
  read: number; applicable: number; passed: number; findings: number;
  /** The worst finding of the area, for the scorecard. */
  top: { title: string; severity: Severity; fingerprint: string } | null;
  /** Up to three passed checks, in the ledger's words. */
  good: string[];
  /** The proof of the score: each finding of the area and the points it cost (score = 100 − their sum, at least 0). */
  penalties: { title: string; severity: Severity; verdict: AuditFinding['verdict']; points: number; fingerprint: string }[];
}

export type ThreatStatus = 'covered' | 'partial' | 'gap' | 'unknown' | 'not_applicable';
export const THREAT_LABEL: Record<ThreatStatus, string> = { covered: 'Covered', partial: 'Partly covered', gap: 'Gap', unknown: 'Not read', not_applicable: 'Not applicable' };

export interface ThreatDef { id: string; label: string; rules: string[]; playbook: string[] }
/** The analyst skill's attack categories that a zone audit can judge, with the rules that bear on each and the playbook steps that close a gap. */
export const THREATS: ThreatDef[] = [
  { id: 'injection', label: 'Injection and known exploits (SQLi, XSS, CVEs)', rules: ['waf.managed_ruleset', 'waf.owasp', 'managed.cf_overrides', 'managed.owasp_tuning', 'managed.free_ruleset', 'managed.exceptions', 'managed.all_disabled', 'waf.broad_skip', 'waf.header_skip', 'traffic.managed_effect', 'traffic.owasp_effect', 'traffic.exception_passthrough'],
    playbook: ['Deploy the Cloudflare Managed Ruleset and the OWASP Core Ruleset on all traffic.', 'Raise OWASP to paranoia level 2 after a week in Log, then Block.', 'Replace broad skip rules with exceptions for one rule on one path.'] },
  { id: 'l7_flood', label: 'HTTP floods (L7 DDoS)', rules: ['avail.ddos_overrides', 'avail.rate_limits', 'avail.ratelimit_depth', 'waf.security_level', 'avail.dev_mode', 'traffic.ratelimit_unused'],
    playbook: ['Keep HTTP DDoS protection at default sensitivity.', 'Rate limit expensive paths (100 requests per 10 seconds per IP → Managed Challenge).', 'In an attack: Security Level “I\'m Under Attack” and a custom rule blocking the attack\'s user agent or network.'] },
  { id: 'credential_stuffing', label: 'Credential stuffing and brute force', rules: ['managed.leaked_credentials', 'avail.login_rate_limit', 'bots.login_turnstile', 'traffic.credential_stuffing', 'avail.rate_limits'],
    playbook: ['Rate limit login POSTs (5 per minute per IP, block 10 minutes).', 'Turn on leaked credentials detection and challenge leaked logins.', 'Add Turnstile to the login form.'] },
  { id: 'bots', label: 'Bots and scraping', rules: ['waf.bot_fight', 'bots.sbfm_config', 'bots.bm_rules', 'bots.ai_bots', 'traffic.passthrough', 'traffic.unmitigated_networks'],
    playbook: ['Turn on Bot Fight Mode (Free) or Super Bot Fight Mode (Pro and up) with “definitely automated” blocked.', 'Challenge hosting networks on paths people use.', 'Enterprise: block bot scores below 30 on sensitive paths.'] },
  { id: 'admin', label: 'Exposed admin areas', rules: ['access.admin_paths', 'origin.risky_names'],
    playbook: ['Put admin paths behind Cloudflare Access (free for up to 50 users).', 'Or allow them only from office and VPN addresses with a custom rule.'] },
  { id: 'api_abuse', label: 'API abuse and enumeration', rules: ['api.shield', 'traffic.api_enumeration'],
    playbook: ['Rate limit data endpoints per client.', 'Require an Authorization header where the API is never anonymous.', 'Enterprise: API Shield schema validation and sequence rules.'] },
  { id: 'cache', label: 'Cache poisoning and deception', rules: ['cache.private_caching', 'cache.deception_armor', 'cache.unkeyed_query', 'cache.poisoning_headers'],
    playbook: ['Never cache per-user paths; bypass cache for session cookies.', 'Turn on Cache Deception Armor on cache-everything rules.', 'Remove X-Forwarded-Host, X-Original-URL and X-Rewrite-URL before the origin.'] },
  { id: 'origin', label: 'Origin exposure and bypass', rules: ['origin.leak', 'tls.origin_pulls', 'host.origin_overrides', 'tls.ssl_mode'],
    playbook: ['Proxy every record that points at the origin; rotate the origin address if it leaked.', 'Allow only Cloudflare\'s addresses at the origin firewall, and turn on Authenticated Origin Pulls.', 'Or use Cloudflare Tunnel so the origin has no public address.'] },
  { id: 'takeover', label: 'Subdomain takeover', rules: ['origin.dangling_cname', 'origin.wildcard'],
    playbook: ['Delete CNAMEs to services you no longer use, or reclaim the resource first.', 'Remove DNS records before closing a third-party account.'] },
  { id: 'transport', label: 'Eavesdropping and downgrade', rules: ['tls.ssl_mode', 'tls.min_version', 'tls.always_https', 'tls.hsts', 'tls.tls13', 'tls.certificates'],
    playbook: ['SSL Full (strict), TLS 1.2 minimum, Always Use HTTPS and HSTS.'] },
  { id: 'spoofing', label: 'Email spoofing and rogue certificates', rules: ['email.spf', 'email.dmarc', 'email.caa', 'dns.dnssec'],
    playbook: ['Publish SPF and DMARC (p=reject once reports are clean) and CAA; turn on DNSSEC.'] },
  { id: 'client', label: 'Browser-side script injection', rules: ['client.page_shield', 'client.security_headers'],
    playbook: ['Set a Content-Security-Policy at the edge; watch scripts with Page Shield.'] },
];

export interface Threat {
  id: string; label: string; status: ThreatStatus;
  /** The proof of the status: each check that bears on the threat and its result. */
  checks: { ruleId: string; title: string; state: CoverageEntry['state']; findings: number }[];
  controls: string[];
  gaps: { title: string; severity: Severity; fingerprint: string }[];
  playbook: string[];
}

export interface Step { title: string; detail: string; severity: Severity | null; fingerprint?: string }
export interface Upgrade { feature: string; plan: string; why: string }

export interface Enforcement {
  /** Security events in the window (null: not read). */
  events: number | null;
  /** Blocked or challenged, out of the events that ended in a decision (null: not read or no decision). */
  enforcedShare: number | null;
  /** Managed and custom rule matches that were only logged — the passive form of waf-detector's monitor-mode signal (null: not read or none). */
  logOnlyShare: number | null;
  /** Challenges solved, out of challenges issued (null: fewer than 10 issued, or not read). */
  solveRate: number | null;
  /** Bot or malicious requests that got through rules that log, skip or allow (null: nothing analysed). */
  badLetThrough: number | null;
  /** Configured, enabled rules with no event in the window, of the configured ones. */
  silent: number | null; configured: number | null;
  /** Events against the window before: +0.4 is 40% more (null: not read). */
  trend: number | null;
  /** The inputs of each number above, from the rule effectiveness rows (themselves sums of the analytics rows). */
  proof: {
    enforcedByAction: Record<string, number>; passiveByAction: Record<string, number>;
    wafLogged: number; wafDecided: number; challenged: number; solved: number; previous: number | null;
    badByRule: { rule: string; bots: number; malicious: number }[];
    silentRules: string[];
  } | null;
}

export interface Posture {
  grade: string | null; label: string; score: number | null;
  /** The proof of the score: each graded area's score and weight, the weighted mean, and the cap applied. */
  gradeProof: { rows: { area: string; score: number; weight: number }[]; mean: number | null; cap: string | null };
  verdict: string;
  areas: AreaScore[];
  enforcement: Enforcement;
  threats: Threat[];
  steps: { immediate: Step[]; shortTerm: Step[]; hardening: Step[]; more: number };
  upgrades: Upgrade[];
  /** Controls that cost nothing on any plan and would close a finding. */
  noCost: { title: string; fingerprint: string }[];
  monitor: string[];
  limits: string[];
}

const ENFORCE = new Set(['block', 'managed_challenge', 'challenge', 'jschallenge', 'js_challenge', 'connection_close', 'connectionclose', 'force_connection_close', 'ddos_dynamic', 'drop']);
const PASSIVE = new Set(['log', 'skip', 'allow', 'bypass', 'whitelist']);
const act = (a: string) => a.toLowerCase().replace(/[\s-]/g, '_');
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** Rules whose finding a no-cost control (on every plan) closes. */
const NO_COST = new Set(['bots.login_turnstile', 'access.admin_paths', 'waf.bot_fight', 'managed.leaked_credentials', 'tls.origin_pulls', 'dns.dnssec', 'email.spf', 'email.dmarc', 'email.caa', 'tls.always_https', 'tls.hsts']);

/** The points one finding costs its area. */
export const penaltyOf = (f: Pick<AuditFinding, 'severity' | 'verdict'>) => PENALTY[f.severity] * (f.verdict === 'confirmed' ? 1 : 0.5);

function areaScore(def: AreaDef, cov: CoverageEntry[], findings: AuditFinding[]): AreaScore {
  const mine = cov.filter((c) => def.groups.includes(c.group));
  const fs = findings.filter((f) => def.groups.includes(f.group));
  const read = mine.filter((c) => c.state === 'passed' || c.state === 'finding').length;
  const applicable = read + mine.filter((c) => c.state === 'not_read').length;
  const base = { id: def.id, label: def.label, what: def.what, weight: def.weight, read, applicable, passed: mine.filter((c) => c.state === 'passed').length, findings: fs.length,
    top: fs.length ? { title: fs[0].title, severity: fs[0].severity, fingerprint: fs[0].fingerprint } : null,
    good: mine.filter((c) => c.state === 'passed' && c.reason).slice(0, 3).map((c) => c.reason!),
    penalties: fs.map((f) => ({ title: f.title, severity: f.severity, verdict: f.verdict, points: penaltyOf(f), fingerprint: f.fingerprint })) };
  if (!applicable) return { ...base, rating: 'not_applicable', score: null };
  if (read * 2 < applicable) return { ...base, rating: 'unknown', score: null };
  const score = Math.max(0, Math.round(100 - fs.reduce((a, f) => a + penaltyOf(f), 0)));
  const confirmedWorst = Math.max(-1, ...fs.filter((f) => f.verdict === 'confirmed').map((f) => SEVERITY_RANK[f.severity]));
  let rating: Rating = score >= 90 ? 'strong' : score >= 70 ? 'fair' : score >= 40 ? 'weak' : 'at_risk';
  if (confirmedWorst >= SEVERITY_RANK.critical) rating = 'at_risk';
  else if (confirmedWorst >= SEVERITY_RANK.high && (rating === 'strong' || rating === 'fair')) rating = 'weak';
  return { ...base, rating, score };
}

function enforcementOf(r: AuditReport): Enforcement {
  const e = r.effectiveness;
  if (!e) return { events: null, enforcedShare: null, logOnlyShare: null, solveRate: null, badLetThrough: null, silent: null, configured: null, trend: null, proof: null };
  let enforced = 0, passive = 0, waf = 0, wafLog = 0, challenged = 0, solved = 0, prev = 0, prevKnown = false, bad = 0, analysed = false;
  const enforcedByAction: Record<string, number> = {}, passiveByAction: Record<string, number> = {};
  const badByRule: { rule: string; bots: number; malicious: number }[] = [];
  for (const x of e.rules) {
    for (const [a, n] of Object.entries(x.byAction)) {
      const k = act(a);
      if (ENFORCE.has(k)) { enforced += n; enforcedByAction[a] = (enforcedByAction[a] ?? 0) + n; } else if (PASSIVE.has(k)) { passive += n; passiveByAction[a] = (passiveByAction[a] ?? 0) + n; }
      if ((x.kind === 'managed' || x.kind === 'custom') && !x.exception) { if (k === 'log') wafLog += n; if (ENFORCE.has(k) || PASSIVE.has(k)) waf += n; }
    }
    challenged += x.challenged; solved += x.solved;
    if (x.previous !== null) { prev += x.previous; prevKnown = true; }
    if (x.passthrough) { analysed = true; bad += x.passthrough.bots + x.passthrough.malicious; if (x.passthrough.bots + x.passthrough.malicious) badByRule.push({ rule: x.name, bots: x.passthrough.bots, malicious: x.passthrough.malicious }); }
  }
  const configured = e.rules.filter((x) => x.configured && x.enabled !== false && !x.exception);
  const silentRules = configured.filter((x) => x.events === 0).map((x) => x.name);
  return {
    events: e.totalEvents,
    enforcedShare: enforced + passive ? enforced / (enforced + passive) : null,
    logOnlyShare: waf ? wafLog / waf : null,
    solveRate: challenged >= 10 ? solved / challenged : null,
    badLetThrough: analysed ? bad : null,
    silent: configured.filter((x) => x.events === 0).length, configured: configured.length,
    trend: prevKnown && prev > 0 ? (e.totalEvents - prev) / prev : null,
    proof: { enforcedByAction, passiveByAction, wafLogged: wafLog, wafDecided: waf, challenged, solved, previous: prevKnown ? prev : null, badByRule: badByRule.sort((a, b) => b.bots + b.malicious - a.bots - a.malicious), silentRules },
  };
}

function threatOf(def: ThreatDef, cov: Map<string, CoverageEntry>, findings: AuditFinding[]): Threat {
  const entries = def.rules.map((id) => cov.get(id)).filter((c): c is CoverageEntry => !!c);
  const fs = findings.filter((f) => def.rules.includes(f.ruleId));
  const read = entries.filter((c) => c.state === 'passed' || c.state === 'finding');
  const base = { id: def.id, label: def.label, checks: entries.map((c) => ({ ruleId: c.ruleId, title: c.title, state: c.state, findings: c.findings })), controls: read.filter((c) => c.state === 'passed' && c.reason).slice(0, 3).map((c) => c.reason!),
    gaps: fs.slice(0, 3).map((f) => ({ title: f.title, severity: f.severity, fingerprint: f.fingerprint })), playbook: def.playbook };
  if (!read.length) return { ...base, status: entries.some((c) => c.state === 'not_read') ? 'unknown' : 'not_applicable', playbook: [] };
  const gap = fs.some((f) => f.verdict === 'confirmed' && SEVERITY_RANK[f.severity] >= SEVERITY_RANK.high);
  const partial = fs.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.medium);
  const status: ThreatStatus = gap ? 'gap' : partial ? 'partial' : 'covered';
  return { ...base, status, playbook: status === 'covered' ? [] : def.playbook };
}

const step = (f: AuditFinding): Step => ({ title: f.title, detail: f.fix[0] ?? '', severity: f.severity, fingerprint: f.fingerprint });

function upgradesOf(plan: string, threats: Threat[]): Upgrade[] {
  const open = (id: string) => { const t = threats.find((x) => x.id === id); return !!t && (t.status === 'gap' || t.status === 'partial'); };
  const out: Upgrade[] = [];
  if (plan === 'free') {
    if (open('injection')) out.push({ feature: 'Cloudflare Managed Ruleset and OWASP Core Ruleset', plan: 'Pro', why: 'The Free plan runs only the Free Managed Ruleset.' });
    if (open('bots')) out.push({ feature: 'Super Bot Fight Mode', plan: 'Pro', why: 'Separate actions for definitely and likely automated traffic, and static-resource protection.' });
  }
  if (plan !== 'enterprise') {
    if (open('bots') || open('credential_stuffing')) out.push({ feature: 'Bot Management (bot score)', plan: 'Enterprise', why: 'A per-request bot score to block automation on login and checkout without challenging people.' });
    if (open('api_abuse')) out.push({ feature: 'API Shield (schema validation, sequence rules)', plan: 'Enterprise', why: 'Blocks undeclared API calls and calls made out of order.' });
    if (open('injection')) out.push({ feature: 'WAF attack score', plan: 'Enterprise', why: 'Catches injection variants the signatures miss, and measures what got through.' });
    if (open('credential_stuffing') || open('l7_flood')) out.push({ feature: 'Advanced Rate Limiting', plan: 'Enterprise', why: 'Counts per session, API key or header instead of per IP, so attackers spread over many addresses are still counted.' });
  }
  return out;
}

function monitorOf(r: AuditReport, en: Enforcement, threats: Threat[]): string[] {
  const out = ['Security › Events, filtered on each rule you change, for 15–30 minutes after the change: matches should keep coming with the new action, without complaints from real users.'];
  if ((r.effectiveness?.recommendations ?? []).some((x) => x.action === 'block_or_challenge')) out.push('After switching a Log rule to Block or Managed Challenge: its challenge solve rate in Security › Events (a high solve rate means people are being challenged).');
  if (en.trend !== null && Math.abs(en.trend) >= 0.5) out.push(`Security events changed by ${en.trend > 0 ? '+' : ''}${pct(en.trend)} against the window before: watch whether the rise is an attack (one path, a few networks) or new traffic.`);
  if (threats.some((t) => t.id === 'credential_stuffing' && t.status !== 'covered' && t.status !== 'not_applicable')) out.push('The share of 401/422 answers on login paths (Analytics › Traffic, filtered on the path): it should fall once rate limits and Turnstile are on.');
  if (threats.some((t) => t.id === 'l7_flood' && t.status !== 'covered')) out.push('Analytics › Traffic for request spikes and origin errors (5xx); Notifications › HTTP DDoS attack alerts.');
  out.push('Run this audit again after the changes: the grade and the scorecard show whether the gaps closed.');
  return out;
}

/** The posture summary of one report. */
export function postureOf(r: AuditReport): Posture {
  const findings = [...r.findings].sort(byWorst);
  const areas = AREAS.map((a) => areaScore(a, r.coverage, findings));
  const graded = areas.filter((a) => a.score !== null);
  const weight = graded.reduce((x, a) => x + a.weight, 0);
  const mean = weight ? Math.round(graded.reduce((x, a) => x + a.score! * a.weight, 0) / weight) : null;
  let score = mean;
  let cap: string | null = null;
  const confirmed = findings.filter((f) => f.verdict === 'confirmed');
  if (score !== null && confirmed.some((f) => f.severity === 'critical')) { const c = GRADES.find((g) => g.grade === 'D')!.min + 9; if (score > c) cap = `A confirmed critical finding caps the score at ${c} (grade D).`; score = Math.min(score, c); }
  else if (score !== null && confirmed.some((f) => f.severity === 'high')) { const c = GRADES.find((g) => g.grade === 'C')!.min + 9; if (score > c) cap = `A confirmed high finding caps the score at ${c} (grade C).`; score = Math.min(score, c); }
  const g = score === null ? null : GRADES.find((x) => score! >= x.min)!;
  const cov = new Map(r.coverage.map((c) => [c.ruleId, c]));
  const threats = THREATS.map((t) => threatOf(t, cov, findings));
  const enforcement = enforcementOf(r);

  // Next steps, by urgency (the analyst skill's Immediate / Short-term / Hardening).
  const immediate = confirmed.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.high).map(step);
  const used = new Set(immediate.map((s) => s.fingerprint));
  const traffic = actionItems(r).filter((x) => x.source === 'traffic' && !used.has(x.fingerprint)).map((x): Step => ({ title: x.title, detail: x.steps[0] ?? '', severity: x.severity, fingerprint: x.fingerprint }));
  traffic.forEach((s) => used.add(s.fingerprint));
  const short = [...findings.filter((f) => !used.has(f.fingerprint) && ((f.verdict === 'needs_validation' && SEVERITY_RANK[f.severity] >= SEVERITY_RANK.high) || (f.verdict === 'confirmed' && f.severity === 'medium'))).map(step), ...traffic];
  short.forEach((s) => used.add(s.fingerprint));
  const hard = findings.filter((f) => !used.has(f.fingerprint) && SEVERITY_RANK[f.severity] >= SEVERITY_RANK.low).map(step);
  const CAP = 8;
  const more = Math.max(0, immediate.length - CAP) + Math.max(0, short.length - CAP) + Math.max(0, hard.length - CAP);

  const notRead = r.coverage.filter((c) => c.state === 'not_read');
  const perms = [...new Set(notRead.map((c) => c.permission).filter(Boolean))];
  const hours = r.effectiveness?.hours;
  const limits = [
    'Passive only: the audit reads the configuration and the traffic Cloudflare logged. It sends no test requests to the zone, so it cannot show how the WAF would treat an evasion attempt that never arrived.',
    'Findings that need validation count half in the score; each says how to settle it.',
    ...(notRead.length ? [`${notRead.length} checks could not be read${perms.length ? ` (token permissions: ${perms.slice(0, 6).join(', ')}${perms.length > 6 ? ', …' : ''})` : ''}; areas with less than half of their checks read are not graded.`] : []),
    ...(hours ? [`Traffic numbers cover ${windowLabel(hours)}${r.effectiveness && r.effectiveness.askedHours > hours ? ` (shortened from ${windowLabel(r.effectiveness.askedHours)} to what the plan keeps)` : ''}; only the busiest paths and networks are read, so counts are lower bounds.`] : ['Security events could not be read: “Rules in practice” is not graded.']),
    'DNS tunneling and network-layer (L3/L4) DDoS are account-level (Gateway, Magic Transit) and outside a zone audit.',
  ];

  // The verdict: grade, the areas, the top risk, and what the rules did.
  const name = r.zone.name;
  const strong = graded.filter((a) => a.rating === 'strong');
  const weakest = graded.filter((a) => a.rating === 'weak' || a.rating === 'at_risk').sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  const ungraded = areas.filter((a) => a.rating === 'unknown');
  const top = findings[0];
  const parts: string[] = [];
  parts.push(g ? `${name} rates ${g.grade} (${g.label}, ${score}/100).` : `${name} could not be graded: too few checks were read.`);
  if (graded.length) parts.push(`${strong.length} of ${graded.length} graded areas are strong${weakest.length ? `; the weakest ${weakest.length === 1 ? 'is' : 'are'} ${weakest.slice(0, 3).map((a) => a.label.toLowerCase()).join(', ')}` : ''}.`);
  if (top) parts.push(`The biggest risk: ${top.title.replace(/\.$/, '')} (${top.severity}${top.verdict === 'needs_validation' ? ', needs validation' : ''}).`);
  else parts.push('No findings in the checks that were read.');
  if (enforcement.events !== null && hours) {
    parts.push(enforcement.events
      ? `In ${windowLabel(hours)} its security rules acted on ${compactNum(enforcement.events)} requests${enforcement.enforcedShare !== null ? `, blocking or challenging ${pct(enforcement.enforcedShare)} of those they decided on` : ''}.`
      : `Its security rules acted on no request in ${windowLabel(hours)}.`);
    if (enforcement.badLetThrough) parts.push(`${compactNum(enforcement.badLetThrough)} bot or malicious requests got through rules that log, skip or allow.`);
  }
  if (ungraded.length) parts.push(`${ungraded.length} area${ungraded.length === 1 ? ' was' : 's were'} not graded because the token could not read ${ungraded.length === 1 ? 'it' : 'them'}.`);

  return {
    grade: g?.grade ?? null, label: g?.label ?? 'Not graded', score, verdict: parts.join(' '),
    gradeProof: { rows: graded.map((a) => ({ area: a.label, score: a.score!, weight: a.weight })), mean, cap },
    areas, enforcement, threats,
    steps: { immediate: immediate.slice(0, CAP), shortTerm: short.slice(0, CAP), hardening: hard.slice(0, CAP), more },
    upgrades: upgradesOf(r.zone.plan, threats),
    noCost: findings.filter((f) => NO_COST.has(f.ruleId)).slice(0, 6).map((f) => ({ title: f.title, fingerprint: f.fingerprint })),
    monitor: monitorOf(r, enforcement, threats), limits,
  };
}
