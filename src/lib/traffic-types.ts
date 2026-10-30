// Monthly traffic analysis: shapes shared by the API (src/lib/traffic.ts) and the page.

export interface TrafficTotals {
  requests: number;
  cachedRequests: number;
  bytes: number;
  cachedBytes: number;
  threats: number;
  pageViews: number;
  /** Sum of each day's unique visitors (daily uniques cannot be added up into a monthly count). */
  uniquesSum: number;
  /** Days with data, for the daily averages. */
  days: number;
}

export interface TrafficDay { date: string; requests: number; cachedRequests: number; bytes: number; cachedBytes: number; threats: number; pageViews: number; uniques: number }

export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx';
export interface TrafficCountry { country: string; requests: number; bytes: number; threats: number }

/** What a zone and an account each carry. */
export interface TrafficSlice {
  totals: TrafficTotals;
  /** The same days of the previous month (the first N days while the month is still running); null when unreadable. */
  previous: TrafficTotals | null;
  daily: TrafficDay[];
  statuses: Record<StatusClass, number> | null;
  countries: TrafficCountry[];
}

export interface TrafficZone extends TrafficSlice {
  id: string;
  name: string;
  plan: string;
  status: 'ok' | 'unavailable' | 'error';
  message?: string;
}

/** What a report covers: one account (all its zones), or one zone of it. */
export interface TrafficScope { accountId: string; accountName: string; zoneId?: string; zoneName?: string }

export interface TrafficReport extends TrafficSlice {
  /** YYYY-MM */
  month: string;
  /** First day (inclusive) and the day after the last (exclusive), YYYY-MM-DD. */
  since: string;
  until: string;
  /** The month is still running: totals cover the days so far. */
  partial: boolean;
  generatedAt: string;
  cachedIn?: 'redis' | 'memory';
  /** 'basic' when Cloudflare refused the per-country and status-code breakdown. */
  detail: 'full' | 'basic';
  scope: TrafficScope;
  /** The account's zones (busiest first), or just the chosen zone. */
  zones: TrafficZone[];
  /** Zones the stored tokens cannot read analytics for. */
  unavailable: number;
  problems: { credential: string; error: string }[];
  /** Months that can be asked for, newest first. */
  months: string[];
}

/** The month is still being read from Cloudflare (answered with 202): ask again in a few seconds. */
export interface TrafficPending {
  pending: true;
  month: string;
  accountId: string;
  zoneId?: string;
  /** Queries finished and planned so far (zones are read in batches; both this and last month). */
  done: number;
  total: number;
  startedAt: string;
}

// ── Zone detail: security events and requests, from Cloudflare's adaptive datasets ──

/** One row of a breakdown: its values (rule ID, IP, path …), and its events or requests (and bytes for requests). */
export interface DetailRow { dims: Record<string, string>; count: number; bytes?: number }

/** One security event as Cloudflare logged it (the fields the zone's plan offers). */
export type FirewallEvent = Record<string, string | number | null>;

export interface DatasetDetail {
  available: boolean;
  /** Why it is not available, or what is missing (a breakdown the plan does not offer …). */
  message?: string;
  notes: string[];
  /** What was read (ISO times): can be shorter than the month — Cloudflare keeps this data for `retentionDays`. */
  since?: string;
  until?: string;
  retentionDays: number | null;
  /** Queries per breakdown: Cloudflare limits how long one query's time range can be. With more than one, top lists are the best of each part. */
  parts: number;
  total: number;
  breakdowns: Record<string, DetailRow[]>;
}

/** Narrows the detail to one client IP, one rule or one (managed) ruleset. */
export interface DetailFilter {
  ip?: string;
  rule?: string;
  ruleset?: string;
  /** One day of the month (YYYY-MM-DD, UTC), and optionally one hour of it (0–23): everything is read for just that time. */
  day?: string;
  hour?: number;
}

/** A managed ruleset deployed on the zone (an execute rule in its managed-rules phase) and how it is tuned. */
export interface ManagedDeployment {
  /** Account level: the zone it is deployed on. */
  zone?: string;
  rulesetId: string;
  name: string;
  description?: string;
  enabled: boolean;
  /** Where it applies (the execute rule's expression); "true" means every request. */
  expression: string;
  /** Action for all its rules, when overridden. */
  action?: string;
  /** OWASP only: the highest paranoia level turned on (PL1 when not overridden). */
  paranoiaLevel?: number;
  /** OWASP only: the anomaly score threshold (60 low, 40 medium, 25 high) and the action when it is exceeded. */
  scoreThreshold?: number;
  anomalyAction?: string;
  categoryOverrides: { category: string; enabled?: boolean; action?: string }[];
  ruleOverrides: { id: string; enabled?: boolean; action?: string; scoreThreshold?: number }[];
}

/** At account level: each zone of the account and whether its detail is in the totals. */
export interface DetailZone { id: string; name: string; status: 'read' | 'unavailable' | 'no traffic' | 'left out'; message?: string }

/** One zone's detail, or (no zoneId) an account's: its zones' breakdowns added up, with a "zones" breakdown. */
export interface ZoneDetail {
  month: string;
  accountId: string;
  accountName: string;
  zoneId?: string;
  zoneName?: string;
  /** Account level only. */
  zones?: DetailZone[];
  filter: DetailFilter | null;
  /** WAF / firewall events: which rules matched, what they did, who triggered them. */
  security: DatasetDetail & { events: FirewallEvent[]; eventsSince?: string };
  /** All HTTP requests (not available when the detail is narrowed to a rule), and single requests, newest first. */
  requests: DatasetDetail & { samples?: FirewallEvent[]; samplesSince?: string; samplesNote?: string };
  /** Ruleset IDs → names (managed rulesets included), for the rules table. */
  rulesetNames: Record<string, string>;
  /** Managed rulesets deployed (not read when the detail is narrowed), and why they could not be read. */
  managed?: ManagedDeployment[];
  managedNote?: string;
  generatedAt: string;
  cachedIn?: 'redis' | 'memory';
}

export interface ZoneDetailPending { pending: true; month: string; accountId: string; zoneId?: string; filter: DetailFilter | null; done: number; total: number; startedAt: string }

/** Cloudflare's managed rulesets (the same IDs in every account), named even when the zone's list is unreadable. */
export const MANAGED_RULESETS: Record<string, string> = {
  efb7b8c949ac4650a09736fc376e9aee: 'Cloudflare Managed Ruleset',
  '4814384a9e5d4991b9815dcfc25d2f1f': 'Cloudflare OWASP Core Ruleset',
  c2e184081120413c86c3ab7e14069605: 'Cloudflare Exposed Credentials Check',
  '77454fe2d30c4220b5701f6fdfb893ba': 'Cloudflare Free Managed Ruleset',
  '4d21379b4f9f4bb088e0729962c8b3cf': 'HTTP DDoS attack protection',
};
export const OWASP_RULESET = '4814384a9e5d4991b9815dcfc25d2f1f';
/** OWASP's "949110: Inbound Anomaly Score Exceeded": its threshold and action are the ruleset's tuning. */
export const OWASP_ANOMALY_RULE = '6179ae15870a4bb7b2d480d4843b323c';

export const EMPTY_TOTALS: TrafficTotals = { requests: 0, cachedRequests: 0, bytes: 0, cachedBytes: 0, threats: 0, pageViews: 0, uniquesSum: 0, days: 0 };
