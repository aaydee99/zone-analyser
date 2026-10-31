// Investigation tools (Ray ID lookup, request trace, WAF false-positive finder, zone timeline): the
// shapes the API answers with. Shared by server and client — no Node imports.

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
}
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
}
export interface TimelineSeries { key: '5xx' | '4xx' | 'blocked' | 'requests'; label: string; points: { t: string; v: number }[] }
export interface TimelineSource { key: string; label: string; status: 'ok' | 'unavailable' | 'error' | 'skipped'; message?: string; count: number }
export interface TimelineReport {
  zoneId: string; zoneName: string; accountId: string; accountName: string;
  hours: number; since: string; until: string; bucketMinutes: number;
  series: TimelineSeries[]; events: TimelineEvent[]; sources: TimelineSource[];
  generatedAt: string;
}
