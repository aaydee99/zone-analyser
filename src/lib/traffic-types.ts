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

export const EMPTY_TOTALS: TrafficTotals = { requests: 0, cachedRequests: 0, bytes: 0, cachedBytes: 0, threats: 0, pageViews: 0, uniquesSum: 0, days: 0 };
