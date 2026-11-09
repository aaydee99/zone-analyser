// Investigation tools (Ray ID lookup, request trace, WAF false-positive finder, zone timeline): the
// shapes the API answers with. Shared by server and client — no Node imports.

import type { CfChange } from './cf-audit-report';
import type { DeployTuning } from './waf-labels';

/** A read still running in the background (see bg-job.ts): ask again with `job` to get its result. */
export interface InvestigatePending { pending: true; job: string; done: number; total: number; startedAt: string; note?: string }

export type Cell = string | number | boolean | null;
export type Fields = Record<string, Cell>;

// ── Ray ID lookup ───────────────────────────────────────────────────────────

export type RayScopeKind = 'zone' | 'host' | 'account' | 'all';
/** Windows a Ray ID is searched in (hours back from now, or around `at`). */
export const RAY_WINDOWS = [1, 6, 24, 72, 168] as const;

export interface RaySearch {
  kind: RayScopeKind;
  /** Zones in the scope, and how many of them were searched before the hit or the query cap. */
  zones: number;
  searched: number;
  queries: number;
  /** The query cap stopped the search before every zone of the scope was searched. */
  capped: boolean;
  maxQueries: number;
  since: string;
  until: string;
  /** How the zones were ordered (busiest first, from cached traffic, when known). */
  ranking: string;
}

export interface RaySecurityEvent {
  datetime: string; action: string; source: string; ruleId: string; rulesetId: string; description: string;
  /** Name of the rule's ruleset (managed rulesets by their Cloudflare name), when known. */
  rulesetName?: string;
  [k: string]: Cell | undefined;
}

export interface RayResult {
  ray: string;
  found: boolean;
  zone?: { id: string; name: string; accountId: string; accountName: string; plan: string };
  at?: string;
  /** The request (httpRequestsAdaptive), when the zone's plan keeps single requests. Field names are Cloudflare's. */
  request: Fields | null;
  /** What security did to it (firewallEventsAdaptive), in the order Cloudflare logged it. */
  events: RaySecurityEvent[];
  /** Fields asked for that the plan does not offer, and other remarks. */
  notes: string[];
  search: RaySearch;
  /** Zones that could not be searched (no analytics access, an error). */
  failed: { zone: string; error: string }[];
  generatedAt: string;
}

// ── Request trace ───────────────────────────────────────────────────────────

export interface TraceStep {
  step_name?: string; type?: string; name?: string; kind?: string; description?: string; expression?: string; action?: string;
  matched?: boolean; action_parameters?: unknown; trace?: TraceStep[];
}
export interface TraceResult { url: string; method: string; zoneName: string; accountName: string; statusCode: number | null; trace: TraceStep[]; generatedAt: string }

// ── WAF false-positive finder ───────────────────────────────────────────────

export const WAF_WINDOWS = [24, 72, 168] as const;

export interface WafSignal { key: string; label: string; points: number; detail: string }
/** One scoring check, scored or not: the numbers measured and the bands that turn them into points. */
export interface WafCheck { key: string; label: string; points: number; measured: string; bands: string }
/** The hard numbers behind a suspect's score, read from Cloudflare's security events in the window. */
export interface WafEvidence {
  since: string; until: string;
  /** Events counted in each breakdown (Cloudflare groups them by IP, network, path and user agent separately). */
  counted: { ips: number; asns: number; paths: number; uas: number };
  /** The busiest of each, most first, with how many there are in all. */
  topIps: { ip: string; count: number }[]; ipCount: number;
  networks: { asn: string; name: string; count: number; consumer: boolean }[]; networkCount: number; consumerEvents: number; hostingEvents: number;
  userAgents: { ua: string; count: number; browser: boolean }[]; uaCount: number; browserEvents: number;
  paths: { host: string; path: string; count: number }[]; pathCount: number;
  /** The main path's responses in the window (all requests, from httpRequestsAdaptiveGroups), or null when not read. */
  pathStatus: { requests: number; stopped: number; others: number; ok: number } | null;
  /** Every check, including the ones that scored 0, and the sum before it is kept within 0–100. */
  checks: WafCheck[]; sum: number;
}
export interface WafSuspect {
  zoneId: string; zoneName: string;
  ruleId: string; rulesetId: string; source: string; description: string; rulesetName?: string;
  /** The path most of its mitigations hit, and that path's share of them. */
  path: string; pathShare: number; host: string;
  mitigated: number; challenged: number; solved: number; blocked: number;
  ips: number; asns: number; residentialShare: number; browserShare: number;
  /** Responses on that path that were 2xx/3xx (from all requests), when it could be read. */
  okShare: number | null;
  score: number; signals: WafSignal[];
  /** The exception to paste into the dashboard (never sent by the console). */
  draft: { phase: string; where: string; expression: string; action: string; actionParameters: Record<string, unknown>; notes: string[] };
  /** What the rule did to these requests, by action, most first. */
  actions: { action: string; count: number }[];
  /** Its main action on these requests. */
  currentAction: string;
  /** Managed rules: how the ruleset is deployed on the zone (Ruleset action and status; OWASP's threshold, paranoia level and action), and this rule's own override. */
  deploy?: DeployTuning & { ruleOverride?: string };
  /** Ways to stop the false positive, the narrowest first. */
  fixes: WafFix[];
  /** How the score was reached, in counts (absent on results kept from before it was added). */
  evidence?: WafEvidence;
}
/** One way to stop a false positive: what to change, why, and the steps in the dashboard. */
export interface WafFix { title: string; why: string; steps: string[]; /** The narrowest change: try it first. */ best?: boolean }
export interface WafZoneResult { zoneId: string; zoneName: string; status: 'ok' | 'unavailable' | 'error' | 'no events'; message?: string; events: number; suspects: WafSuspect[]; since?: string; until?: string }
export interface WafReport {
  scope: { kind: 'zone' | 'account'; id: string; name: string };
  hours: number; offset: number; limit: number; totalZones: number;
  zones: WafZoneResult[]; suspects: WafSuspect[];
  generatedAt: string;
}

// ── Zone timeline ───────────────────────────────────────────────────────────

export const TIMELINE_WINDOWS = [6, 24, 72, 168] as const;
export type TimelineKind = 'config' | 'spike' | 'worker' | 'pages' | 'certificate' | 'alert' | 'finding';
export interface TimelineEvent {
  at: string; kind: TimelineKind; title: string; detail?: string;
  tone?: 'ok' | 'warn' | 'bad' | 'info';
  href?: string;
  /** A configuration change: what changed field by field (old → new), and who made it. */
  change?: CfChange;
}
export interface TimelineSeries { key: '5xx' | '4xx' | 'blocked' | 'requests'; label: string; points: { t: string; v: number }[] }
export interface TimelineSource { key: string; label: string; status: 'ok' | 'unavailable' | 'error' | 'skipped'; message?: string; count: number }
export interface TimelineReport {
  zoneId: string; zoneName: string; accountId: string; accountName: string;
  hours: number; since: string; until: string; bucketMinutes: number;
  series: TimelineSeries[]; events: TimelineEvent[]; sources: TimelineSource[];
  generatedAt: string;
}

// ── Leaked credentials ──────────────────────────────────────────────────────

export const LEAKED_WINDOWS = [24, 72, 168] as const;

/** A custom or rate limiting rule that uses a leaked-credential field. */
export interface LeakedRule {
  phase: 'custom' | 'ratelimit'; id: string; description: string; enabled: boolean; action: string; expression: string;
  /** The credential fields the expression uses (cf.waf.credential_check.*, cf.waf.auth_detected). */
  fields: string[];
  /** Rate limiting: requests per period (seconds). */
  rate?: { requests: number; period: number };
}
export interface LeakedConfig {
  /** Leaked credentials detection on the zone (GET /leaked-credential-checks); null when not read. */
  enabled: boolean | null; enabledNote?: string;
  /** Custom detection locations (Enterprise); null when not read. */
  detections: { id: string; username: string; password: string }[] | null; detectionsNote?: string;
  rules: LeakedRule[]; rulesNote?: string;
  /** The managed transform that adds the Exposed-Credential-Check header to origin requests; null when not read. */
  header: boolean | null;
}
export interface LeakedCount { result: string; count: number }
export interface LeakedTraffic {
  /** The analytics dimension that holds the result (httpRequestsAdaptiveGroups). */
  field: string; since: string; until: string;
  /** All requests in the window by check result (including clean and not checked). */
  results: LeakedCount[];
  /** Requests with a leaked result. */
  leaked: number;
  /** Leaked requests by result and edge status code. */
  byStatus: (LeakedCount & { status: number })[];
  /** Leaked requests by result and security action; null when the plan's analytics do not offer it. */
  byAction: (LeakedCount & { action: string })[] | null;
  paths: (LeakedCount & { host: string; path: string; method: string })[];
  ips: { ip: string; asn: string; asnName: string; country: string; count: number }[];
  hours: (LeakedCount & { hour: string })[];
  note?: string;
}
export interface LeakedFinding { key: string; tone: 'bad' | 'warn' | 'info' | 'ok'; title: string; detail: string; fix?: string[] }
export interface LeakedZone {
  zoneId: string; zoneName: string; plan: string;
  status: 'ok' | 'unavailable' | 'error'; message?: string;
  config: LeakedConfig | null; traffic: LeakedTraffic | null; findings: LeakedFinding[];
}
export interface LeakedReport {
  scope: { kind: 'zone' | 'account'; id: string; name: string };
  hours: number; offset: number; limit: number; totalZones: number;
  zones: LeakedZone[]; generatedAt: string;
}
