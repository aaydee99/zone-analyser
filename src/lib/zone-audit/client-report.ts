// The client version of an audit: "Cloudflare Security Review: Gaps and recommendations". An
// analyst's rewrite of the report in fixed rules, rendered to Word by client-report-docx.ts. Pure (no
// Node imports): the audit page uses it too, to show what the document changes and what to check.
//
// - Findings are grouped by root cause into gaps (THEMES; at most MAX_GAPS, the rest as "Other
//   improvements"), numbered G1… worst first. Every finding is in exactly one gap.
// - The audit's conclusions are checked before they are used: traffic that looks like devices or
//   integrations is not sent to a challenge; fixes are ordered by what they depend on; counts are
//   called logged events; failing paths get a "find the cause first"; a threat with a gap is never
//   "Covered"; risky rollouts get their caveat. Each such change is listed in `departures`.
// - Nothing internal reaches the document: tool name, API paths, queries, commands, IDs, rule
//   slugs, attack-class files, grade and score, origin addresses, and the audit's own wording
//   (clean()). `bannedIn()` finds any that would slip through (the tests run it on the document).

import { postureOf, AREAS, THREATS } from './posture';
import { SOURCES, SEVERITY_RANK, byWorst, windowLabel, type AuditFinding, type AuditReport, type RuleEffect, type RuleGroup, type Severity, GROUP_LABEL } from './types';

export type ClientSeverity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Advisory';
export const CLIENT_SEVERITY: Record<Severity, ClientSeverity> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Advisory' };
export type GapStatus = 'Confirmed' | 'To validate';
export type ThreatState = 'Gap' | 'Partly covered' | 'Covered' | 'Not assessed';

export interface CardRow { label: 'Gap' | 'Evidence' | 'Risk' | 'Validate' | 'Recommendation' | 'Before rollout'; lines: string[] }
export interface Gap {
  id: string;
  title: string;
  severity: ClientSeverity;
  rank: number;
  status: GapStatus;
  findings: number;
  rows: CardRow[];
  /** One line for the summary table and the roadmap. */
  recommendation: string;
  /** Roadmap phase: 1 validate and prepare, 2 fix, 3 harden. */
  phase: 1 | 2 | 3;
  themeId: string;
}
export interface ClientReport {
  fileName: string;
  zone: string;
  client: string;
  preparedOn: string;
  window: string | null;
  executive: { situation: string[]; priorities: string[]; counts: { severity: ClientSeverity; findings: number; confirmed: number; toValidate: number }[]; total: number };
  scope: string[];
  limits: string[];
  threats: { threat: string; status: ThreatState; inPlace: string; mainGap: string }[];
  gaps: Gap[];
  roadmap: { phases: { title: string; why: string; items: string[] }[]; inputs: string[]; measures: string[] };
  working: { area: string; items: string[] }[];
  appendices: { title: string; intro: string; head: string[]; rows: string[][] }[];
  /** For the reviewer, not in the document: where the report departs from the audit. */
  departures: string[];
  /** For the reviewer: what to check before sending. */
  checks: string[];
}

// ── Clean-up: nothing internal in the client's text ─────────────────────────

const RULE_ID = /\b(?:tls|origin|email|dns|managed|waf|bypass|bots|access|avail|cache|host|client|api|edge|traffic)\.(?:[a-z0-9]+_)*[a-z0-9]+\b(?![.-]?[a-z0-9]*\.[a-z])/g;
const HEX_ID = /\b[0-9a-f]{32}\b/gi;
const API_PATH = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[^\s,;)]*/g;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?:\/\d{1,2})?\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b|\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?:\/\d{1,3})?/gi;
const COMMAND = /`[^`]*\b(?:curl|openssl|dig|whois|nslookup|wget|nc)\b[^`]*`/gi;

/** Plain client text: no dashes, no internal names, IDs, paths, commands or addresses. */
export function clean(s: string, ruleIds: Set<string> = new Set(), names: Map<string, string> = new Map()): string {
  let t = String(s ?? '');
  for (const [id, name] of names) if (t.includes(id)) t = t.split(id).join(`"${name}"`);
  t = t.replace(COMMAND, 'a test request');
  t = t.replace(/\(see [^)]*\)/gi, '');
  // Pointers to the audit's own sections and tabs, which the client report does not have.
  t = t.replace(/[^.]*\bthe (?:traffic|effectiveness|coverage|findings|method|verification) (?:section|tab|ledger)\b[^.]*\.?/gi, '');
  t = t.replace(/\((?:see |in )?(?:the )?(?:Effectiveness|Coverage|Findings|Recommended Actions|Managed Ruleset|Posture)(?: tab| section)?\)/g, '');
  t = t.replace(/\bcastellan\b/gi, 'the review');
  t = t.replace(API_PATH, 'the configuration');
  t = t.replace(/\bgraphql\b/gi, 'analytics').replace(/\bfingerprints?\b/gi, 'reference');
  t = t.replace(/\bheuristic(?:ally)?\b/gi, 'estimated');
  t = t.replace(/Matches Cloudflare['’]s answer\.?/gi, '');
  t = t.replace(/\b[\w-]+\.md\b/gi, '');
  t = t.replace(HEX_ID, '');
  // Only the audit's own rule IDs: Cloudflare fields such as cf.waf.score look alike and must stay.
  t = t.replace(RULE_ID, (m, at: number, all: string) => (ruleIds.has(m) && all[at - 1] !== '.' ? '' : m));
  t = t.replace(IPV6, 'a published address').replace(IPV4, 'a published address');
  // A range between numbers ("15–30") reads "15 to 30"; any other dash becomes a comma.
  t = t.replace(/(\d)\s*–\s*(\d)/g, '$1 to $2');
  t = t.replace(/\s+[—–]\s+/g, ', ').replace(/[—–]/g, ', ');
  t = t.replace(/\s*→\s*/g, ' to ').replace(/`/g, '');
  t = t.replace(/\(\s*\)/g, '').replace(/\s+([,.;:])/g, '$1').replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim();
  return t;
}

/** What must never be in the client's document (case-insensitive), with the zone ID and origin addresses of this report. */
export function bannedIn(text: string, extra: string[] = []): string[] {
  const lower = text.toLowerCase();
  const words = ['castellan', 'graphql', 'fingerprint', 'curl ', 'openssl', 'heuristic', '.md', 'matches cloudflare'];
  const hits = words.filter((w) => lower.includes(w));
  for (const x of extra) if (x && lower.includes(x.toLowerCase())) hits.push(x);
  if (/[—–]/.test(text)) hits.push('em or en dash');
  if (HEX_ID.test(text)) hits.push('32-character ID');
  HEX_ID.lastIndex = 0;
  return hits;
}

// ── Gaps: findings by root cause ────────────────────────────────────────────

interface Theme { id: string; title: string; rules: string[]; rollout?: string[] }
const THEMES: Theme[] = [
  { id: 'origin_tls', title: 'Encryption between Cloudflare and the origin', rules: ['tls.ssl_mode', 'tls.origin_pulls', 'tls.automatic_mode'],
    rollout: ['Check that every origin hostname presents a valid certificate (publicly trusted, or a Cloudflare Origin CA certificate) before choosing Full (strict); otherwise visitors see certificate errors.'] },
  { id: 'https', title: 'HTTPS enforcement for visitors', rules: ['tls.always_https', 'tls.hsts', 'tls.https_rewrites', 'tls.opportunistic_encryption'],
    rollout: ['HSTS is hard to reverse: browsers remember it for the whole max-age. Start with a short max-age without preload, and raise it once every subdomain serves HTTPS.'] },
  { id: 'tls_versions', title: 'Older TLS versions accepted', rules: ['tls.min_version', 'tls.tls13', 'tls.0rtt'],
    rollout: ['Before raising the minimum TLS version, confirm that older devices or integrations still using TLS 1.0 or 1.1 can move to TLS 1.2.'] },
  { id: 'certificates', title: 'Edge certificates', rules: ['tls.certificates', 'tls.universal_ssl'] },
  { id: 'origin', title: 'Origin exposure', rules: ['origin.leak', 'origin.risky_names', 'host.origin_overrides', 'origin.wildcard'] },
  { id: 'takeover', title: 'DNS records open to takeover', rules: ['origin.dangling_cname'] },
  { id: 'email', title: 'Email and DNS authenticity', rules: ['email.spf', 'email.dmarc', 'email.caa', 'dns.dnssec'],
    rollout: ['Move DMARC to p=reject only after its reports show that every legitimate sender passes.'] },
  { id: 'managed_missing', title: 'Managed rules not deployed', rules: ['waf.managed_ruleset', 'waf.owasp', 'managed.free_ruleset', 'managed.all_disabled', 'managed.sensitive_data'],
    rollout: ['Deploy new managed rules in Log for a few days, review the matches, then switch to their default action.'] },
  { id: 'managed_log', title: 'Managed rules set to log only or loosely tuned', rules: ['managed.cf_overrides', 'managed.owasp_tuning', 'traffic.managed_log', 'traffic.managed_effect', 'traffic.owasp_effect'],
    rollout: ['Add narrow exceptions for the legitimate matches before removing a ruleset-wide Log override, so the change does not block real users.'] },
  { id: 'bypass', title: 'Rules that switch security off', rules: ['waf.broad_skip', 'waf.header_skip', 'bypass.config_rules', 'bypass.lockdowns', 'bypass.page_rules', 'bypass.ua_rules', 'bypass.ip_access_allow', 'bypass.account_ip_access_allow', 'managed.exceptions', 'traffic.exception_passthrough', 'waf.disabled_rules'] },
  { id: 'custom', title: 'Custom rules that let traffic through', rules: ['waf.custom_log_only', 'traffic.passthrough', 'traffic.zero_hits', 'traffic.false_positive', 'traffic.unmitigated_paths'] },
  { id: 'bots', title: 'Bot protection', rules: ['waf.bot_fight', 'bots.sbfm_config', 'bots.bm_rules', 'bots.ai_bots', 'traffic.unmitigated_networks'],
    rollout: ['Managed Challenge suits browsers only: devices, apps and integrations cannot complete one.'] },
  { id: 'login', title: 'Login and credential abuse', rules: ['avail.login_rate_limit', 'bots.login_turnstile', 'managed.leaked_credentials', 'traffic.credential_stuffing'],
    rollout: ['Turnstile works on browser forms only; protect app and API logins with rate limits instead.'] },
  { id: 'availability', title: 'Rate limiting and DDoS settings', rules: ['avail.rate_limits', 'avail.ratelimit_depth', 'avail.ddos_overrides', 'traffic.ratelimit_unused', 'avail.dev_mode', 'waf.security_level', 'waf.challenge_ttl', 'waf.browser_check'] },
  { id: 'admin', title: 'Admin areas reachable from the internet', rules: ['access.admin_paths'] },
  { id: 'api', title: 'API protection', rules: ['api.shield', 'traffic.api_enumeration'] },
  { id: 'cache', title: 'Cache poisoning and deception', rules: ['cache.deception_armor', 'cache.poisoning_headers', 'cache.private_caching', 'cache.unkeyed_query'] },
  { id: 'headers', title: 'Trust in client-supplied headers', rules: ['host.true_client_ip'] },
  { id: 'client', title: 'Browser-side and edge protections', rules: ['client.page_shield', 'client.security_headers', 'client.email_obfuscation', 'client.hotlink_protection', 'client.server_side_exclude', 'edge.worker_routes', 'edge.websockets', 'waf.ip_geolocation'] },
];
const THEME_OF = new Map(THEMES.flatMap((t) => t.rules.map((r) => [r, t] as const)));
/** The theme of a rule (tests check that every audit rule has one). */
export const themeOf = (ruleId: string) => THEME_OF.get(ruleId)?.id ?? null;
/** Fixes that other fixes depend on come first, in this order (the rest by severity). */
const ORDER = ['origin_tls', 'managed_log', 'bypass', 'custom', 'origin', 'https', 'tls_versions'];
const MAX_GAPS = 15;

/** Plain checks for the validations that name commands in the audit. */
const VALIDATE: Record<string, string> = {
  'tls.ssl_mode': 'Confirm the certificate each origin presents: valid for the hostname, or a Cloudflare Origin CA certificate. Replace any self-signed or expired certificate first.',
  'tls.always_https': 'Request each hostname over plain HTTP: a redirect to HTTPS settles it; a page served over HTTP confirms the gap.',
  'tls.hsts': 'Check whether the origin already sends a Strict-Transport-Security header with a long max-age on every hostname.',
  'tls.origin_pulls': 'Confirm whether the origin firewall accepts only Cloudflare addresses, or checks Cloudflare\'s client certificate.',
  'origin.leak': 'From outside Cloudflare, check whether the origin answers requests sent straight to its address. If it does, every edge control can be bypassed.',
  'origin.risky_names': 'Open each listed hostname from outside your network: a login page, dashboard or listing means it is exposed; a timeout or refusal settles it.',
  'origin.dangling_cname': 'Confirm that the target of each listed record still exists in the service it points to; if not, remove the record or reclaim the resource.',
  'origin.wildcard': 'Request a random name under the wildcard and decide whether the origin should answer it.',
  'email.dmarc': 'Review the DMARC aggregate reports to see which senders pass before tightening the policy.',
  'host.origin_overrides': 'Confirm with the application owner that the overridden host or origin is intended and trusted.',
  'cache.deception_armor': 'Request a private page with a static-looking extension added and confirm the answer is not cached.',
  'cache.private_caching': 'Confirm that the listed paths never return content specific to a signed-in user.',
  'cache.unkeyed_query': 'Confirm that the query strings ignored by the cache never change the page content.',
  'cache.poisoning_headers': 'Confirm whether the origin builds links or redirects from forwarded-host headers.',
  'client.security_headers': 'Check the response headers of the main pages for a Content-Security-Policy and the other security headers.',
  'edge.worker_routes': 'Confirm with the application owner what the listed Worker routes do and that they check input.',
  'access.admin_paths': 'Open each listed admin path from outside your network and confirm whether it asks for a login before showing anything.',
  'avail.ratelimit_depth': 'Confirm the expected request rate of the protected paths, so the limit stops abuse without stopping busy users.',
  'traffic.credential_stuffing': 'Confirm with the application owner whether the failed logins come from real users, partners or attacks.',
};

const SERVICE_PATH = /^\/(?:api|v\d+|graphql|rest|rpc|webhooks?|hooks?|services?|soap|ws|mobile|app|device|sync|feeds?|oauth|token|health)\b|\.(?:json|xml|asmx|svc)\b/i;

interface Group { theme: Theme | null; key: string; title: string; findings: AuditFinding[] }

const sevOf = (fs: AuditFinding[]) => fs.reduce<Severity>((w, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[w] ? f.severity : w), 'info');
const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
/** A capital first letter, unless the text starts with a hostname or a path (kept as written). */
const capital = (t: string) => (/^(?:[a-z0-9-]+\.)+[a-z0-9-]+\b|^\//i.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1));
const sentence = (s: string) => { const t = capital(s.trim()); return !t || /[.!?:]$/.test(t) ? t : `${t}.`; };
const approx = (n: number) => (n >= 1000 ? `about ${Number(n.toPrecision(2)).toLocaleString('en-US')}` : String(n));
const share = (x: number) => (x > 0 && x < 0.01 ? 'less than 1%' : `about ${Math.round(x * 100)}%`);

function effectOf(r: AuditReport, f: AuditFinding): RuleEffect | null {
  const e = r.effectiveness;
  if (!e) return null;
  const rec = e.recommendations.find((x) => x.fingerprint === f.fingerprint);
  return rec ? e.rules.find((x) => x.key === rec.ruleKey) ?? null : null;
}

/** Devices or integrations, not browsers: mostly automated, few hosting networks and few browsers, on service endpoints. */
function looksLikeIntegrations(e: RuleEffect | null): boolean {
  const p = e?.passthrough;
  if (!p || p.passed < 50) return false;
  const servicePaths = p.topPaths.reduce((n, x) => n + (SERVICE_PATH.test(x.path) ? x.count : 0), 0);
  const pathShare = p.topPaths.length ? servicePaths / Math.max(1, p.topPaths.reduce((n, x) => n + x.count, 0)) : 0;
  return p.botShare >= 0.5 && p.hostingShare < 0.3 && p.browserShare < 0.3 && pathShare >= 0.5;
}

/** Settings as the dashboard names them. */
const SETTING_NAME: Record<string, string> = {
  ssl: 'SSL/TLS encryption mode', min_tls_version: 'Minimum TLS version', tls_1_3: 'TLS 1.3', always_use_https: 'Always Use HTTPS', automatic_https_rewrites: 'Automatic HTTPS Rewrites',
  security_header: 'HSTS', security_level: 'Security level', browser_check: 'Browser integrity check', development_mode: 'Development mode', true_client_ip_header: 'True-Client-IP header',
  cache_level: 'Caching level', '0rtt': '0-RTT', opportunistic_encryption: 'Opportunistic Encryption', email_obfuscation: 'Email obfuscation', hotlink_protection: 'Hotlink protection',
  server_side_exclude: 'Server-side excludes', challenge_ttl: 'Challenge passage', websockets: 'WebSockets', ip_geolocation: 'IP geolocation', ssl_automatic_mode: 'SSL/TLS recommender',
};
const TRAFFIC_KEYS = new Set(['events', 'events_previous', 'requests']);
/** Evidence fields read outside a named source, in plain words. */
const FIELD_NAME: Record<string, string> = { rcode: 'Public DNS answer', value: 'Value' };

function evidenceOf(f: AuditFinding, ids: Set<string>, names: Map<string, string>, skipTraffic: boolean): string[] {
  // The window's length ("hours") is in the scope section; traffic numbers come from the traffic lines.
  return f.evidence.filter((e) => e.field !== 'hours' && !(skipTraffic && e.key && TRAFFIC_KEYS.has(e.key))).slice(0, 3).map((e) => {
    const setting = e.key?.startsWith('setting:') ? SETTING_NAME[e.key.slice(8)] : undefined;
    const label = setting ?? (e.key ? SOURCES[e.key]?.label ?? FIELD_NAME[e.field] ?? e.field : FIELD_NAME[e.field] ?? e.field);
    const field = e.field && e.field !== 'value' ? ` (${e.field})` : '';
    const v = String(e.value ?? '');
    const line = clean(`${label}${setting || label === e.field || label === FIELD_NAME[e.field] ? '' : field}: ${v.length > 200 ? `${v.slice(0, 200)}…` : v}`, ids, names);
    return capital(line);
  });
}

function trafficLines(e: RuleEffect, ids: Set<string>, names: Map<string, string>): string[] {
  const rule = clean(e.name, ids, names) || 'This rule';
  const out = [`"${rule}": ${approx(e.events)} logged events in the window (sampled; one request can match several rules).`];
  if (e.topAsns.length) out.push(`Top networks: ${e.topAsns.slice(0, 4).map((x) => `${clean(x.name || `AS${x.asn}`, ids, names)} (${approx(x.count)})`).join(', ')}.`);
  if (e.topPaths.length) out.push(`Top paths: ${e.topPaths.slice(0, 4).map((x) => `${clean(x.path, ids, names)} (${approx(x.count)})`).join(', ')}.`);
  const p = e.passthrough;
  if (p) out.push(`Of ${approx(p.passed)} requests it let through, ${share(p.botShare)} look automated${p.botBasis === 'score' ? '' : ' (estimated from user agents)'}, ${share(p.hostingShare).replace('about ', '')} come from hosting networks and ${share(p.browserShare).replace('about ', '')} from browsers.`);
  return out;
}

// ── The report ──────────────────────────────────────────────────────────────

const fmtDay = (d: Date) => d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' });

export function clientReport(r: AuditReport, opts: { client: string; preparedOn?: Date }): ClientReport {
  const ids = new Set(r.coverage.map((c) => c.ruleId));
  const departures: string[] = [];
  const posture = postureOf(r);
  const findings = [...r.findings].sort(byWorst);
  // Rule and ruleset IDs in the audit's text become the names the dashboard shows.
  const names = new Map<string, string>();
  for (const x of r.effectiveness?.rules ?? []) { if (x.ruleId && x.name && x.name !== x.ruleId) names.set(x.ruleId, x.name); }
  for (const m of r.managed?.rulesets ?? []) if (m.id && m.name) names.set(m.id, m.name);
  const C = (s: string) => clean(s, ids, names);

  // Group by theme (unknown rules by their audit group), worst first; beyond MAX_GAPS, the rest merge.
  const groups = new Map<string, Group>();
  for (const f of findings) {
    const label = GROUP_LABEL[f.group as RuleGroup];
    const t = THEME_OF.get(f.ruleId) ?? THEMES.find((x) => x.title === label) ?? null;
    const key = t?.id ?? `group:${f.group}`;
    const g = groups.get(key) ?? { theme: t, key, title: t?.title ?? GROUP_LABEL[f.group as RuleGroup] ?? 'Other gaps', findings: [] };
    g.findings.push(f);
    groups.set(key, g);
  }
  let list = [...groups.values()].sort((a, b) => SEVERITY_RANK[sevOf(b.findings)] - SEVERITY_RANK[sevOf(a.findings)]
    || Number(b.findings.some((f) => f.verdict === 'confirmed')) - Number(a.findings.some((f) => f.verdict === 'confirmed')) || b.findings.length - a.findings.length);
  if (list.length > MAX_GAPS) {
    const rest = list.slice(MAX_GAPS - 1);
    list = [...list.slice(0, MAX_GAPS - 1), { theme: null, key: 'other', title: 'Other improvements', findings: rest.flatMap((g) => g.findings).sort(byWorst) }];
    departures.push(`${rest.length} smaller groups of findings are merged into one gap, "Other improvements", to keep the report to ${MAX_GAPS} gaps.`);
  }

  const gaps: Gap[] = list.map((g, i) => {
    const id = `G${i + 1}`;
    const sev = sevOf(g.findings);
    const worst = g.findings.filter((f) => f.severity === sev);
    let status: GapStatus = worst.some((f) => f.verdict === 'confirmed') ? 'Confirmed' : 'To validate';
    const effects = uniq(g.findings.map((f) => effectOf(r, f)?.key ?? '')).map((k) => r.effectiveness!.rules.find((x) => x.key === k)!).filter(Boolean);
    const integration = effects.find((e) => looksLikeIntegrations(e));
    /** Findings whose traffic looks like devices or integrations: their "block or challenge" fix is replaced below. */
    const integrationFindings = new Set(g.findings.filter((f) => looksLikeIntegrations(effectOf(r, f))).map((f) => f.fingerprint));
    const shown = g.findings.slice(0, 6);
    const rows: CardRow[] = [];
    rows.push({ label: 'Gap', lines: [...shown.map((f) => sentence(C(f.title))), ...(g.findings.length > shown.length ? [`And ${g.findings.length - shown.length} more of the same kind.`] : [])] });
    // Traffic first (the networks and paths are the evidence a reader acts on), then what was read.
    const ev = uniq([...effects.slice(0, 2).flatMap((e) => trafficLines(e, ids, names)), ...shown.flatMap((f) => evidenceOf(f, ids, names, effects.length > 0))]).slice(0, 10);
    if (ev.length) rows.push({ label: 'Evidence', lines: ev });
    // A traffic finding's description says "it": name the rule it is about.
    const risk = uniq(shown.map((f) => { const ef = effectOf(r, f); const d = sentence(C(f.description)); return ef ? `"${C(ef.name) || 'This rule'}": ${d}` : d; })).slice(0, 3);
    if (risk.length) rows.push({ label: 'Risk', lines: risk });
    const validate = uniq(g.findings.filter((f) => f.verdict === 'needs_validation').map((f) => sentence(VALIDATE[f.ruleId] ?? C(f.validation ?? '')))).slice(0, 4);
    let recs = uniq(shown.filter((f) => !integrationFindings.has(f.fingerprint)).flatMap((f) => f.fix.map((x) => sentence(C(x))))).slice(0, 6);
    const before: string[] = [...(g.theme?.rollout ?? [])];

    if (integration) {
      const nets = integration.passthrough!.topAsns.slice(0, 3).map((x) => C(x.name || `AS${x.asn}`)).join(', ');
      validate.unshift(`Confirm with us which devices, apps or partner integrations call these endpoints${nets ? ` (top networks: ${nets})` : ''}.`);
      const rule = C(integration.name) || 'this rule';
      recs = [`For "${rule}", classify this traffic first: it comes mostly from ISP and enterprise networks, few browsers, and service endpoints, which suggests devices or integrations rather than attackers.`,
        `Add narrow exceptions to "${rule}" for the clients you confirm, then challenge or block the rest of its automated traffic.`, ...recs].slice(0, 7);
      before.push(`Do not apply Managed Challenge to the traffic of "${rule}": devices and integrations cannot complete one, so they would fail.`);
      recs = recs.filter((l) => !/Managed Challenge|Block/.test(l) || l.includes(`"${rule}"`) || (/[“"][^”"]+[”"]/.test(l) && !l.includes(rule)));
      status = 'To validate';
      departures.push(`${id} (${g.title}): the audit recommends blocking or challenging; the report asks to classify the traffic first, because it looks like devices or integrations (low hosting-network and browser shares, service endpoints).`);
    }
    const failing = effects.find((e) => { const s = e.passthrough?.statuses; const n = s ? s.s2xx + s.s3xx + s.s4xx + s.s5xx : 0; return s && n >= 50 && s.s4xx / n >= 0.3; });
    if (failing) before.push(`Many of the requests "${C(failing.name) || 'this rule'}" let through end in 4xx errors. Find out why first (a missing file such as a favicon, or a workflow failing again and again) before adding a rate limit.`);
    if (g.theme?.id === 'origin' && findings.some((f) => f.ruleId === 'tls.ssl_mode' && /flexible|off/i.test(f.evidence[0]?.value ?? ''))) {
      before.push('Fix the SSL mode (see the encryption gap) before proxying a DNS-only record: configuration rules apply only to proxied traffic.');
      departures.push(`${id}: added that the SSL mode must be fixed before proxying DNS-only records.`);
    }
    if (g.theme?.id === 'managed_log' && groups.has('bypass')) before.push('Review the exceptions in the "Rules that switch security off" gap at the same time, so each skip stays as narrow as possible.');

    if (validate.length) rows.push({ label: 'Validate', lines: validate });
    if (recs.length) rows.push({ label: 'Recommendation', lines: recs });
    if (before.length) rows.push({ label: 'Before rollout', lines: uniq(before) });
    const phase: Gap['phase'] = status === 'To validate' ? 1 : SEVERITY_RANK[sev] >= SEVERITY_RANK.medium ? 2 : 3;
    return { id, title: g.title, severity: CLIENT_SEVERITY[sev], rank: SEVERITY_RANK[sev], status, findings: g.findings.length, rows,
      recommendation: (recs[0] ?? 'Review and decide with Adapture.').replace(/\.$/, ''), phase, themeId: g.theme?.id ?? g.key };
  });
  const gapOfRule = new Map<string, Gap>();
  list.forEach((g, i) => g.findings.forEach((f) => gapOfRule.set(f.ruleId, gaps[i])));

  // Counts, as the audit found them.
  const sevs: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
  const counts = sevs.map((s) => ({ severity: CLIENT_SEVERITY[s], findings: findings.filter((f) => f.severity === s).length,
    confirmed: findings.filter((f) => f.severity === s && f.verdict === 'confirmed').length, toValidate: findings.filter((f) => f.severity === s && f.verdict === 'needs_validation').length }))
    .filter((c) => c.severity !== 'Critical' || c.findings > 0);
  if (findings.some((f) => f.severity === 'info')) departures.push('The audit\'s Info severity is shown as Advisory.');
  if (findings.some((f) => f.severity === 'critical')) departures.push('Critical findings keep their own row in the severity table, above High.');
  departures.push(`${findings.length} findings are grouped into ${gaps.length} gaps by root cause; the severity table keeps the original counts.`);

  // Threats: the audit's status, never "Covered" while a gap applies.
  const threats = posture.threats.filter((t) => t.status !== 'not_applicable').map((t) => {
    const def = THREATS.find((x) => x.id === t.id)!;
    const related = uniq(def.rules.map((rid) => gapOfRule.get(rid)?.id ?? '')).map((gid) => gaps.find((g) => g.id === gid)!).filter(Boolean).sort((a, b) => b.rank - a.rank);
    let status: ThreatState = t.status === 'gap' ? 'Gap' : t.status === 'partial' ? 'Partly covered' : t.status === 'covered' ? 'Covered' : 'Not assessed';
    if (status === 'Covered' && related.length) { status = 'Partly covered'; departures.push(`Threat "${C(t.label)}": shown as Partly covered, not Covered, because ${related.map((g) => g.id).join(', ')} applies.`); }
    return { threat: C(t.label), status, inPlace: t.controls.length ? C(t.controls.slice(0, 2).join(' ')) : status === 'Not assessed' ? 'Not assessed with the access granted.' : 'Nothing specific found.',
      mainGap: related.length ? `${related[0].id}: ${related[0].title}` : status === 'Covered' ? 'None found.' : status === 'Not assessed' ? 'Not assessed.' : 'None found.' };
  });

  // Window and scope.
  const e = r.effectiveness;
  const window = e ? `${fmtDay(new Date(e.since))} to ${fmtDay(new Date(e.until))} (${windowLabel(e.hours)})` : null;
  const notRead = r.coverage.filter((c) => c.state === 'not_read').length;
  const scope = [
    `Adapture reviewed the Cloudflare configuration of ${r.zone.name} (${r.zone.plan} plan) and its security analytics. The review was read-only: nothing was changed and no test traffic was sent.`,
    window ? `Traffic data covers ${window}.` : 'Security analytics could not be read for this review, so the traffic sections are not included.',
    `${r.coverage.length} checks were run across encryption, origin and DNS, web application firewall, bots, rate limiting, admin and login protection, caching and browser-side protections.`,
  ];
  const estimated = e?.rules.some((x) => x.passthrough && (x.passthrough.botBasis !== 'score' || x.passthrough.maliciousBasis !== 'attack_score'));
  const limits = [
    'Analytics are sampled and only the busiest paths and networks are read, so traffic numbers are approximate.',
    'One request can match several rules, so event counts overlap between rules: they are logged events, not unique requests.',
    ...(estimated ? ['Where the plan does not score requests, automated and malicious traffic is estimated from user agents, paths and networks.'] : []),
    ...(notRead ? [`${notRead} checks could not be read with the access granted; they are marked as not assessed.`] : []),
    'Out of scope: network-layer DDoS and DNS tunnelling (account-level services), the application\'s own code, and systems behind the origin.',
  ];

  // Executive summary.
  const total = findings.length;
  const confirmed = findings.filter((f) => f.verdict === 'confirmed').length;
  const situation = [
    total ? `The review found ${total} issues on ${r.zone.name}, grouped into ${gaps.length} gaps. ${confirmed} are confirmed by the configuration or traffic; ${total - confirmed} need a check with you before any change.`
      : `The review found no gaps on ${r.zone.name} in the checks that could be read.`,
    ...(posture.enforcement.events !== null && e ? [`In the window, the security rules acted on ${approx(posture.enforcement.events)} logged events${posture.enforcement.enforcedShare !== null ? `, and ${share(posture.enforcement.enforcedShare)} of their decisions were blocks or challenges` : ''}.`] : []),
  ];
  const priorities = [...gaps].sort((a, b) => b.rank - a.rank || Number(a.status === 'To validate') - Number(b.status === 'To validate')).slice(0, 4)
    .map((g) => `${g.id}: ${g.title}. ${sentence(g.recommendation)}`);

  // Roadmap, by dependency.
  const ordered = (ps: Gap[]) => [...ps].sort((a, b) => { const ia = ORDER.indexOf(a.themeId), ib = ORDER.indexOf(b.themeId); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || b.rank - a.rank; });
  const item = (g: Gap) => `${g.id}: ${g.title}. ${sentence(g.recommendation)}`;
  const phases = [
    { title: 'Phase 1: Validate and prepare', why: 'Settle the gaps that depend on information only you have, and prepare the changes others depend on.', items: ordered(gaps.filter((g) => g.phase === 1)).map(item) },
    { title: 'Phase 2: Fix the confirmed gaps', why: 'In this order: the origin encryption and the exceptions that later changes rely on first, then the rest by severity.', items: ordered(gaps.filter((g) => g.phase === 2)).map(item) },
    { title: 'Phase 3: Harden', why: 'Lower-risk improvements, once the earlier changes have run without user impact.', items: ordered(gaps.filter((g) => g.phase === 3)).map(item) },
  ].filter((p) => p.items.length);
  const has = (id: string) => gaps.some((g) => g.themeId === id);
  const inputs = uniq([
    ...(gaps.some((g) => g.rows.some((x) => x.label === 'Validate' && x.lines.some((l) => /devices, apps or partner/.test(l)))) ? ['Which devices, apps and partner integrations call the service endpoints named in the gaps marked To validate.'] : []),
    ...(has('origin_tls') ? ['Who manages the origin servers and their certificates.'] : []),
    ...(has('origin') || has('takeover') ? ['Which DNS records must stay unproxied, and which are no longer used.'] : []),
    ...(has('email') ? ['Every service that sends email for the domain.'] : []),
    ...(has('admin') ? ['Who needs the admin areas, and from which networks.'] : []),
    'A contact who can approve rule changes and report any user impact after each change.',
  ]);
  const measures = [
    'Each change is watched in Security Events for the first hours: matches keep arriving with the new action, without complaints from real users.',
    'Rules moved from Log to Block or Managed Challenge are checked for their challenge solve rate (a high rate means people are being challenged).',
    'A follow-up review over the same traffic window confirms which gaps are closed.',
  ];

  // What is working well: passed checks by area.
  const working = AREAS.map((a) => ({ area: a.label, items: uniq(r.coverage.filter((c) => c.state === 'passed' && c.reason && a.groups.includes(c.group)).map((c) => sentence(C(c.reason!)))).slice(0, 5) })).filter((x) => x.items.length);

  // Appendices: logged rule matches, and rules whose let-through traffic often fails.
  const appendices: ClientReport['appendices'] = [];
  const logged = (e?.rules ?? []).map((x) => ({ x, n: Object.entries(x.byAction).filter(([a]) => /^log$/i.test(a)).reduce((s, [, v]) => s + v, 0) })).filter((y) => y.n > 0).sort((a, b) => b.n - a.n).slice(0, 15);
  if (logged.length) appendices.push({ title: 'Logged rule matches', intro: 'Rules that matched requests but only logged them in the window (approximate, sampled; a request can appear under several rules).',
    head: ['Rule', 'Type', 'Logged events', 'Top paths'], rows: logged.map(({ x, n }) => [C(x.name) || 'Unnamed rule', C(x.kind === 'managed' ? 'Managed rule' : x.kind === 'custom' ? 'Custom rule' : x.kind), approx(n), x.topPaths.slice(0, 3).map((p) => C(p.path)).join(', ') || 'Not available']) });
  const fails = (e?.rules ?? []).filter((x) => x.passthrough?.statuses && x.passthrough.statuses.s4xx > 0).map((x) => { const s = x.passthrough!.statuses!; const n = s.s2xx + s.s3xx + s.s4xx + s.s5xx; return { x, s, n }; })
    .filter((y) => y.n > 0 && y.s.s4xx / y.n >= 0.1).sort((a, b) => b.s.s4xx - a.s.s4xx).slice(0, 15);
  if (fails.length) appendices.push({ title: 'Paths with failing requests', intro: 'Requests let through by these rules that often ended in 4xx errors. Some are harmless (a missing favicon); repeated failures on a workflow point to an application fault.',
    head: ['Rule', '4xx share', 'Requests', 'Top paths'], rows: fails.map(({ x, s, n }) => [C(x.name) || 'Unnamed rule', `${Math.round((s.s4xx / n) * 100)}%`, approx(n), x.passthrough!.topPaths.slice(0, 3).map((p) => C(p.path)).join(', ') || 'Not available']) });

  departures.push('Left out for the client: grade and score, method, verification and analytics query sections, IDs, API paths, origin addresses and test commands. Validation steps are rewritten in plain language.');
  const client = opts.client.trim() || 'Client';
  const checks = [
    `Confirm the client name on the cover ("${client}").`,
    'Check whether customer or product names appearing in paths (Evidence rows and appendices) should stay.',
    'Dates, owners and a logo are not included; add them in Word if needed.',
    'Review the gaps marked To validate, and where the report departs from the audit (listed below), before sending.',
  ];
  return {
    fileName: `${r.zone.name.replace(/[^A-Za-z0-9._-]+/g, '-')}-Gaps-and-Recommendations.docx`,
    zone: r.zone.name, client, preparedOn: fmtDay(opts.preparedOn ?? new Date()), window,
    executive: { situation, priorities, counts, total },
    scope, limits, threats, gaps, roadmap: { phases, inputs, measures }, working, appendices, departures, checks,
  };
}
