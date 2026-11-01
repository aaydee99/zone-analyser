// Security audit of one zone: the shapes shared by the rule engine (rules.ts), the reader (read.ts),
// the store (store.ts), the renderers (render.ts) and the pages. Pure — no Node or network imports.
//
// The audit is the security-audit skill's validation discipline turned into fixed rules: each rule
// names the skill's attack class it implements and the file it comes from, a finding is `confirmed`
// only when the zone's configuration itself proves the outcome, and `needs_validation` otherwise,
// with the exact check to run. Nothing here guesses or scores: every condition is plain code.

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** confirmed: the configuration proves the outcome. needs_validation: it depends on something the configuration cannot show. */
export type Verdict = 'confirmed' | 'needs_validation';

export interface Evidence {
  /** The API path or setting id the value was read from (e.g. "GET /zones/{id}/settings/ssl"). */
  source: string;
  field: string;
  /** Shown as read; secret-looking values are masked (redact). */
  value: string;
}

/** One finding (the skill's report-schema.json record without file and line). */
export interface AuditFinding {
  /** Stable across runs: zone:<zoneId>:<ruleId>[:<resource>]. */
  fingerprint: string;
  ruleId: string;
  group: RuleGroup;
  verdict: Verdict;
  severity: Severity;
  attackClass: string;
  /** The skill file the attack class comes from. */
  skillRef: string;
  title: string;
  description: string;
  rootCause: string;
  intendedBehavior: string;
  evidence: Evidence[];
  /** The smallest effective change, as dashboard steps. Never applied by the console. */
  fix: string[];
  /** needs_validation: the exact check that settles it. */
  validation: string | null;
}

/** passed · finding · not_applicable (plan or feature absent) · not_read (permission or API error). */
export type CoverageState = 'passed' | 'finding' | 'not_applicable' | 'not_read';
export const COVERAGE_STATES: CoverageState[] = ['finding', 'not_read', 'not_applicable', 'passed'];

export interface CoverageEntry {
  ruleId: string;
  title: string;
  group: RuleGroup;
  attackClass: string;
  skillRef: string;
  state: CoverageState;
  findings: number;
  /** not_applicable / not_read: why. passed: what was checked. */
  reason?: string;
  /** not_read: the Cloudflare token permission that reads the missing data. */
  permission?: string;
}

export type RuleGroup = 'transport' | 'origin' | 'email' | 'waf' | 'availability' | 'cache' | 'host' | 'client' | 'edge' | 'traffic';
export const GROUP_LABEL: Record<RuleGroup, string> = {
  transport: 'Transport and session', origin: 'Origin exposure and reachability', email: 'Email spoofing and certificate issuance',
  waf: 'WAF and application rules', availability: 'Availability', cache: 'Cache poisoning and deception', host: 'Host and forwarded-header trust',
  client: 'Client-side protections', edge: 'Edge runtime boundary', traffic: 'Rule effectiveness (traffic)',
};

export interface AuditSummary {
  bySeverity: Record<Severity, number>;
  byVerdict: Record<Verdict, number>;
  coverage: Record<CoverageState, number>;
  /** The worst severity found, or null when nothing was found. */
  worst: Severity | null;
  rules: number;
  /** Cloudflare API calls and public DNS lookups the audit made. */
  calls: number;
  lookups: number;
  error?: string;
}

export interface AuditZone { id: string; name: string; accountId: string; accountName: string; plan: string; type: string; status: string }

/** What an audit stores: the findings (worst first), every rule's coverage, and how it was read. */
export interface AuditReport {
  version: 1;
  zone: AuditZone;
  startedAt: string;
  finishedAt: string;
  findings: AuditFinding[];
  coverage: CoverageEntry[];
  summary: AuditSummary;
  /** Each read: its source key, what it is, and how it went (for the report's method section). */
  reads: { key: string; label: string; state: Got<unknown>['state']; reason?: string }[];
  /** How each security rule acted on traffic in the window (null when security events could not be read). */
  effectiveness: Effectiveness | null;
}

export type AuditStatus = 'running' | 'ready' | 'failed';

/** An audit as listed (no report). */
export interface AuditListItem {
  id: string;
  zoneId: string;
  zoneName: string;
  accountId: string | null;
  startedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: AuditStatus;
  summary: AuditSummary | null;
}
export interface AuditView extends AuditListItem { report: AuditReport | null }

// ── The snapshot the rules read ─────────────────────────────────────────────

/**
 * One read. ok: the value. absent: Cloudflare says the product is not on this zone or plan (404, or
 * a refusal naming the plan). error: anything else — no permission, a rate limit, no answer.
 */
export type Got<T> = { state: 'ok'; value: T } | { state: 'absent'; reason: string } | { state: 'error'; reason: string; status: number };

/** The zone settings the rules read (one GET /settings/{id} each). */
export const AUDIT_SETTINGS = [
  'ssl', 'min_tls_version', 'tls_1_3', 'always_use_https', 'automatic_https_rewrites', 'security_header',
  'security_level', 'browser_check', 'development_mode', 'true_client_ip_header', 'cache_level',
] as const;
export type AuditSetting = (typeof AUDIT_SETTINGS)[number];

/** The ruleset phases the rules read (GET /rulesets/phases/{phase}/entrypoint; 404 = no rules). */
export const AUDIT_PHASES = [
  'http_request_firewall_custom', 'http_request_firewall_managed', 'http_ratelimit', 'ddos_l7',
  'http_request_cache_settings', 'http_request_origin', 'http_response_headers_transform',
] as const;
export type AuditPhase = (typeof AUDIT_PHASES)[number];

export type SourceKey = 'zone' | `setting:${AuditSetting}` | `phase:${AuditPhase}` | 'dns' | 'dnssec' | 'certificates' | 'aop' | 'bot' | 'page_shield'
  | 'page_rules' | 'worker_routes' | 'managed_headers' | 'cname_lookups' | 'events' | 'events_previous' | 'requests';

/** Each source: what it is, where it is read and the token permission that reads it (Cloudflare's names). */
export const SOURCES: Record<SourceKey, { label: string; path: string; permission: string }> = {
  zone: { label: 'Zone details and plan', path: 'GET /zones/{id}', permission: 'Zone Read' },
  ...Object.fromEntries(AUDIT_SETTINGS.map((s) => [`setting:${s}`, { label: `Setting ${s}`, path: `GET /zones/{id}/settings/${s}`, permission: 'Zone Settings Read' }])),
  'phase:http_request_firewall_custom': { label: 'WAF custom rules', path: 'GET /zones/{id}/rulesets/phases/http_request_firewall_custom/entrypoint', permission: 'Zone WAF Read' },
  'phase:http_request_firewall_managed': { label: 'WAF managed rules', path: 'GET /zones/{id}/rulesets/phases/http_request_firewall_managed/entrypoint', permission: 'Zone WAF Read' },
  'phase:http_ratelimit': { label: 'Rate limiting rules', path: 'GET /zones/{id}/rulesets/phases/http_ratelimit/entrypoint', permission: 'Zone WAF Read' },
  'phase:ddos_l7': { label: 'HTTP DDoS protection overrides', path: 'GET /zones/{id}/rulesets/phases/ddos_l7/entrypoint', permission: 'HTTP DDoS Managed Ruleset Read' },
  'phase:http_request_cache_settings': { label: 'Cache rules', path: 'GET /zones/{id}/rulesets/phases/http_request_cache_settings/entrypoint', permission: 'Cache Settings Read' },
  'phase:http_request_origin': { label: 'Origin rules', path: 'GET /zones/{id}/rulesets/phases/http_request_origin/entrypoint', permission: 'Origin Read' },
  'phase:http_response_headers_transform': { label: 'Response header transform rules', path: 'GET /zones/{id}/rulesets/phases/http_response_headers_transform/entrypoint', permission: 'Transform Rules Read' },
  dns: { label: 'DNS records', path: 'GET /zones/{id}/dns_records', permission: 'DNS Read' },
  dnssec: { label: 'DNSSEC', path: 'GET /zones/{id}/dnssec', permission: 'DNS Read' },
  certificates: { label: 'Edge certificate packs', path: 'GET /zones/{id}/ssl/certificate_packs?status=all', permission: 'SSL and Certificates Read' },
  aop: { label: 'Authenticated origin pulls', path: 'GET /zones/{id}/origin_tls_client_auth/settings', permission: 'SSL and Certificates Read' },
  bot: { label: 'Bot protection', path: 'GET /zones/{id}/bot_management', permission: 'Bot Management Read' },
  page_shield: { label: 'Page Shield (client-side security)', path: 'GET /zones/{id}/page_shield', permission: 'Page Shield Read' },
  page_rules: { label: 'Page rules', path: 'GET /zones/{id}/pagerules', permission: 'Page Rules Read' },
  worker_routes: { label: 'Worker routes', path: 'GET /zones/{id}/workers/routes', permission: 'Workers Routes Read' },
  managed_headers: { label: 'Managed transforms', path: 'GET /zones/{id}/managed_headers', permission: 'Managed headers Read' },
  cname_lookups: { label: 'Public DNS answers for CNAME targets', path: 'DNS-over-HTTPS (1.1.1.1), A record of each target', permission: 'none (public DNS; DNS_HEALTH_DOH must not be off)' },
  events: { label: 'Security events in the window', path: 'GraphQL firewallEventsAdaptiveGroups (query only)', permission: 'Analytics Read' },
  events_previous: { label: 'Security events in the window before', path: 'GraphQL firewallEventsAdaptiveGroups (query only)', permission: 'Analytics Read' },
  requests: { label: 'HTTP requests by path, network and status in the window', path: 'GraphQL httpRequestsAdaptiveGroups (query only)', permission: 'Analytics Read' },
} as Record<SourceKey, { label: string; path: string; permission: string }>;

export interface ZoneInfo { id: string; name: string; status: string; type: string; plan: string }
export interface DnsRec { id?: string; name: string; type: string; content: string; proxied?: boolean }
export interface RulesetRule { id?: string; ref?: string; description?: string; expression?: string; action?: string; enabled?: boolean; action_parameters?: Record<string, unknown>; logging?: { enabled?: boolean } }
export interface CertPack { id: string; type?: string; status?: string; hosts?: string[]; certificates?: { expires_on?: string; status?: string }[] }
export interface PageRule { id: string; status?: string; targets?: { constraint?: { value?: string } }[]; actions?: { id: string; value?: unknown }[] }
export interface WorkerRoute { id: string; pattern: string; script?: string | null }
export interface BotConfig { fight_mode?: boolean; sbfm_definitely_automated?: string; sbfm_likely_automated?: string; using_latest_model?: boolean; enable_js?: boolean }
/** RCODE per CNAME target (0 resolves, 3 NXDOMAIN, 2 SERVFAIL), and how many targets were not looked up (cap). */
export interface CnameLookups { answers: Record<string, number>; skipped: number }

// ── Traffic (the "Rule effectiveness" section) ──────────────────────────────

/** The windows an audit can look at (hours); clamped to what the zone's plan keeps. */
export const AUDIT_WINDOWS = [24, 168, 720] as const;
export const DEFAULT_WINDOW = 168;
export const windowLabel = (h: number) => (h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hours`);

/** Security events grouped as read (summed over the parts of the window). */
export interface EventRow { ruleId: string; rulesetId: string; source: string; action: string; description: string; count: number }
export interface EventData {
  since: string;
  until: string;
  rules: EventRow[];
  /** Per rule and action: the paths, countries, networks, client IPs and user agents it acted on (top rows only). */
  paths: { ruleId: string; source: string; action: string; path: string; host: string; count: number }[];
  countries: { ruleId: string; source: string; country: string; count: number }[];
  asns: { ruleId: string; source: string; action: string; asn: string; name: string; count: number }[];
  ips: { ruleId: string; source: string; action: string; ip: string; count: number }[];
  uas: { ruleId: string; source: string; ua: string; count: number }[];
  /** Notes: a part of the window not read, the window clamped to the plan's retention… */
  notes: string[];
}
/** HTTP requests in the window: by path and status, and by network and status (top rows). */
export interface RequestData {
  since: string;
  until: string;
  paths: { host: string; path: string; status: number; count: number }[];
  asns: { asn: string; name: string; status: number; count: number }[];
  notes: string[];
}

export type RuleKind = 'custom' | 'managed' | 'ratelimit' | 'bot' | 'ddos' | 'other';
export const KIND_LABEL: Record<RuleKind, string> = { custom: 'Custom rule', managed: 'Managed rule', ratelimit: 'Rate limiting rule', bot: 'Bot protection', ddos: 'HTTP DDoS protection', other: 'Other security feature' };

/** One security rule's effect in the window. */
export interface RuleEffect {
  key: string;
  kind: RuleKind;
  source: string;
  ruleId: string;
  rulesetId: string;
  name: string;
  /** In the zone's configuration (an entrypoint rule), with its action there. */
  configured: boolean;
  configAction: string | null;
  enabled: boolean | null;
  events: number;
  byAction: Record<string, number>;
  /** Challenges issued and solved; the solve rate when at least 10 were issued. */
  challenged: number;
  solved: number;
  solveRate: number | null;
  topPaths: { path: string; count: number }[];
  topCountries: { country: string; count: number }[];
  topAsns: { asn: string; name: string; count: number }[];
  /** Events in the window before (null: not read or older than the plan keeps). */
  previous: number | null;
  /** (events - previous) / previous; null when previous is null or 0. */
  trend: number | null;
}
export interface Effectiveness {
  hours: number;
  /** The window asked for, when the plan keeps less (the window was shortened). */
  askedHours: number;
  since: string;
  until: string;
  previousSince: string | null;
  totalEvents: number;
  rules: RuleEffect[];
  notes: string[];
}

/** Everything an audit read, keyed by source. A missing key is an error (never a pass). */
export interface Snapshot {
  zoneId: string;
  zoneName: string;
  /** "now" for expiry checks (ISO), so a fixture gives the same result every time. */
  now: string;
  reads: Partial<Record<SourceKey, Got<unknown>>>;
  /** The traffic window (hours) read for `events`, and the one asked for. */
  hours?: number;
  askedHours?: number;
}

// ── Helpers shared by the rules, the renderers and the pages ────────────────

const SECRET = /secret|password|passwd|private_?key|api_?key|client_?key|psk|authorization|signing_?key|access_?key|^token$|_token$|^auth_?key$|cookie|bearer/i;
export const MASK = '••••••••';

/** A value as evidence: secret-looking fields masked, long values cut (with the length said). */
export function redact(field: string, value: unknown): string {
  if (SECRET.test(field)) return MASK;
  const s = typeof value === 'string' ? value : value === undefined ? '(not set)' : JSON.stringify(value);
  const masked = s.replace(/([?&](?:[^=&]*(?:secret|key|sig|token|password|auth|credential)[^=&]*)=)[^&\s"]*/gi, `$1${MASK}`)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, `$1${MASK}`);
  return masked.length > 400 ? `${masked.slice(0, 400)}… (${masked.length} characters)` : masked;
}

export function emptySummary(): AuditSummary {
  return { bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byVerdict: { confirmed: 0, needs_validation: 0 }, coverage: { passed: 0, finding: 0, not_applicable: 0, not_read: 0 }, worst: null, rules: 0, calls: 0, lookups: 0 };
}

/** Worst first: severity, then confirmed before needs_validation, then the fingerprint. */
export const byWorst = (a: AuditFinding, b: AuditFinding) =>
  SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.verdict === b.verdict ? 0 : a.verdict === 'confirmed' ? -1 : 1) || a.fingerprint.localeCompare(b.fingerprint);

export const VERDICT_LABEL: Record<Verdict, string> = { confirmed: 'Confirmed', needs_validation: 'Needs validation' };
export const COVERAGE_LABEL: Record<CoverageState, string> = { passed: 'Passed', finding: 'Finding', not_applicable: 'Not applicable', not_read: 'Not read' };
export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
