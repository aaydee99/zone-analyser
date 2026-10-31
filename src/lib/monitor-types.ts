// Monitoring: the checks, what they report and what they find. Shared by server and client — no Node imports.

import type { Permission } from './rbac';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export type CheckId = 'posture' | 'certificates' | 'governance' | 'drift' | 'alerts' | 'availability' | 'platform' | 'appsec' | 'pagerules'
  | 'dns' | 'loadbalancing' | 'lists';

export interface CheckMeta {
  id: CheckId;
  label: string;
  /** One line under the page title. */
  description: string;
  /** Who may see the page and its findings. */
  perm: Permission;
  /** Token permissions the check reads with, shown when a read is refused. */
  needs: string[];
  /** Default hours between runs (changed in the settings). */
  every: number;
  /** What one run is, in the settings: "each account's notifications" … */
  unit: string;
}

export const CHECKS: CheckMeta[] = [
  { id: 'posture', every: 24, unit: "each account’s Security Insights", label: 'Security posture', perm: 'runs:read', needs: ['Account: Account Settings Read', 'Zone: Zone Read'],
    description: 'Risks Cloudflare’s Security Insights found in each account: exposed records, weak TLS, missing protections, users without MFA.' },
  { id: 'certificates', every: 24, unit: "each zone’s certificates (every 6 hours when one expires within 14 days)", label: 'Certificates', perm: 'runs:read', needs: ['Zone: SSL and Certificates Read', 'Account: Account SSL and Certificates Read'],
    description: 'Every edge, custom-hostname, Origin CA, client and mTLS certificate, with the days left and any validation problem.' },
  { id: 'governance', every: 24, unit: "each account’s tokens and members", label: 'Tokens & members', perm: 'audit:read', needs: ['User: API Tokens Read', 'Account: Account API Tokens Read', 'Account: Account Settings Read'],
    description: 'API tokens that are expired, expiring, unused or unrestricted, and account members without two-factor sign-in.' },
  { id: 'drift', every: 1, unit: "each account’s audit log for changes (every zone is also read in full once a week)", label: 'Drift', perm: 'runs:read', needs: ['Zone: Zone Settings Read', 'Zone: DNS Read', 'Zone: Zone WAF / Rulesets Read'],
    description: 'Settings, rules and DNS that changed since the accepted baseline, and DNSSEC problems.' },
  { id: 'alerts', every: 1, unit: "each account’s notifications", label: 'Cloudflare alerts', perm: 'runs:read', needs: ['Account: Notifications Read'],
    description: 'The notifications each account has switched on, the ones it has not, and alerts Cloudflare sent to the console.' },
  { id: 'availability', every: 1, unit: "each zone and account with health checks, pools, tunnels or waiting rooms (others once a day)", label: 'Availability', perm: 'runs:read', needs: ['Zone: Health Checks Read', 'Account: Load Balancing: Monitors and Pools Read', 'Account: Cloudflare Tunnel Read', 'Zone: Waiting Rooms Read'],
    description: 'Health checks, load-balancer pools, tunnels and waiting rooms, with their current status.' },
  { id: 'platform', every: 6, unit: "each account’s Workers, Pages and storage", label: 'Developer platform', perm: 'runs:read', needs: ['Account: Workers Scripts Read', 'Account: Cloudflare Pages Read', 'Account: Workers R2 Storage Read', 'Account: Workers KV Storage Read', 'Account: D1 Read', 'Account: Queues Read'],
    description: 'Workers, Pages projects, R2 buckets, KV namespaces, D1 databases and queues in each account.' },
  { id: 'appsec', every: 24, unit: "each zone with Page Shield or API Shield data (others once a week)", label: 'Scripts & APIs', perm: 'runs:read', needs: ['Zone: Page Shield Read', 'Zone: API Gateway Read'],
    description: 'Third-party scripts and connections Page Shield sees on your pages, and the API endpoints API Shield knows.' },
  { id: 'pagerules', every: 24, unit: "each zone with Page Rules (others once a week)", label: 'Page Rules', perm: 'runs:read', needs: ['Zone: Page Rules Read'],
    description: 'Page Rules still in use, and the modern rule each one should move to before Cloudflare retires them.' },
  { id: 'dns', every: 24, unit: "each zone’s DNS records, delegation and DNSSEC (plus public DNS lookups over 1.1.1.1)", label: 'DNS hygiene', perm: 'runs:read', needs: ['Zone: Zone Read', 'Zone: DNS Read'],
    description: 'Dangling CNAMEs on takeover-prone services, nameserver delegation, DNSSEC against the DS at the registrar, and unproxied records that expose an origin.' },
  { id: 'loadbalancing', every: 1, unit: "each account’s pools and their health (each zone’s load balancers every 6 hours; none: once a week)", label: 'Load balancing', perm: 'runs:read', needs: ['Account: Load Balancing: Monitors and Pools Read', 'Zone: Load Balancers Read', 'Zone: Analytics Read'],
    description: 'Load balancers, pools and origins with their health in each region, and failovers in the last 24 hours. Read-only: nothing is drained or switched.' },
  { id: 'lists', every: 24, unit: "each account’s lists and account rules (and the rules of its zones, when it has lists)", label: 'IP & ASN lists', perm: 'runs:read', needs: ['Account: Account Filter Lists Read', 'Account: Account Rulesets Read', 'Zone: Zone WAF / Rulesets Read'],
    description: 'IP, ASN, hostname and redirect lists, their size, and the rules that use each one.' },
];
export const CHECK: Record<CheckId, CheckMeta> = Object.fromEntries(CHECKS.map((c) => [c.id, c])) as Record<CheckId, CheckMeta>;
export const isCheckId = (v: unknown): v is CheckId => typeof v === 'string' && v in CHECK;

export interface Finding {
  id: string;
  check: CheckId;
  severity: Severity;
  title: string;
  detail: string;
  accountId?: string | null;
  accountName?: string | null;
  zoneId?: string | null;
  zoneName?: string | null;
  firstSeen: string;
  lastSeen: string;
  resolvedAt?: string | null;
  dismissedAt?: string | null;
  dismissedBy?: string | null;
  notifiedAt?: string | null;
}

/** How a column's values are shown. */
export type ColumnKind = 'text' | 'mono' | 'date' | 'days' | 'number' | 'status' | 'severity' | 'bool' | 'link';
export interface Column { key: string; label: string; kind?: ColumnKind }
export type Cell = string | number | boolean | null;
export type Tone = 'ok' | 'warn' | 'bad' | 'info';
/** A row: its cells by column key; `_tone` colours the row's status (ok, warn, bad, info). */
export type Row = { [key: string]: Cell | undefined } & { _tone?: Tone | null };

export interface ReportStat { label: string; value: string | number; tone?: 'ok' | 'warn' | 'bad' | 'signal' }

/** One table of a check's page; its rows come a page at a time (GET /api/monitors/{check}/rows). */
export interface SectionView {
  key: string;
  title: string;
  description?: string;
  columns: Column[];
  empty?: string;
  total: number;
}

/** How much of a check has been read: its units (one per zone, account, or the whole console). */
export interface Coverage {
  targets: number;
  /** Read in full on their last run. */
  read: number;
  /** Their last run failed or read only part. */
  failing: number;
  /** Not read yet. */
  never: number;
  /** Waiting for their turn now. */
  due: number;
  lastRun: string | null;
}

/** A read that failed, and where. */
export interface ReportProblem { scope: string; error: string; at: string }

/** GET /api/monitors/{check}: totals, the tables (without rows), coverage and failed reads. */
export interface CheckView {
  meta: CheckMeta;
  stats: ReportStat[];
  sections: SectionView[];
  coverage: Coverage;
  open: Record<Severity, number>;
  problems: ReportProblem[];
  generatedAt: string;
}

export interface RowsPage { rows: Row[]; total: number; offset: number }
export interface FindingsPage { findings: Finding[]; total: number; offset: number }

/** One API token's share of Cloudflare's rate limit, as monitoring uses it. */
export interface LaneView {
  name: string;
  /** Calls in the last 5 minutes, and the most monitoring may make. */
  used: number;
  budget: number;
  running: number;
  accounts: number;
  zones: number;
  /** Why monitoring waits on this token (a backup or restore uses it, or Cloudflare answered 429). */
  paused: string | null;
}

/** The worker's monitoring queue right now. */
export interface QueueView {
  /** Units running or waiting for their turn. */
  busy: boolean;
  running: number;
  due: number;
  lanes: LaneView[];
  /** When the accounts and zones were last listed. */
  discoveredAt: string | null;
  scheduled: boolean;
  /** Why nothing runs (monitoring is not set up, the worker has no tokens …). */
  note: string | null;
}

/** GET /api/monitors: every check at a glance. */
export interface MonitorOverview {
  checks: { meta: CheckMeta; coverage: Coverage; open: Record<Severity, number>; interval: number }[];
  queue: QueueView;
  generatedAt: string;
}
