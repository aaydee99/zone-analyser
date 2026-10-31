// Monitoring: the checks, what they report and what they find. Shared by server and client — no Node imports.

import type { Permission } from './rbac';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export type CheckId = 'posture' | 'certificates' | 'governance' | 'drift' | 'alerts' | 'availability' | 'platform' | 'appsec' | 'pagerules';

export interface CheckMeta {
  id: CheckId;
  label: string;
  /** One line under the page title. */
  description: string;
  /** Who may see the page and its findings. */
  perm: Permission;
  /** Token permissions the check reads with, shown when a read is refused. */
  needs: string[];
}

export const CHECKS: CheckMeta[] = [
  { id: 'posture', label: 'Security posture', perm: 'runs:read', needs: ['Account: Account Settings Read', 'Zone: Zone Read'],
    description: 'Risks Cloudflare’s Security Insights found in each account: exposed records, weak TLS, missing protections, users without MFA.' },
  { id: 'certificates', label: 'Certificates', perm: 'runs:read', needs: ['Zone: SSL and Certificates Read', 'Account: Account SSL and Certificates Read'],
    description: 'Every edge, custom-hostname, Origin CA, client and mTLS certificate, with the days left and any validation problem.' },
  { id: 'governance', label: 'Tokens & members', perm: 'audit:read', needs: ['User: API Tokens Read', 'Account: Account API Tokens Read', 'Account: Account Settings Read'],
    description: 'API tokens that are expired, expiring, unused or unrestricted, and account members without two-factor sign-in.' },
  { id: 'drift', label: 'Drift', perm: 'runs:read', needs: ['Zone: Zone Settings Read', 'Zone: DNS Read', 'Zone: Zone WAF / Rulesets Read'],
    description: 'Settings, rules and DNS that changed since the accepted baseline, and DNSSEC problems.' },
  { id: 'alerts', label: 'Cloudflare alerts', perm: 'runs:read', needs: ['Account: Notifications Read'],
    description: 'The notifications each account has switched on, the ones it has not, and alerts Cloudflare sent to the console.' },
  { id: 'availability', label: 'Availability', perm: 'runs:read', needs: ['Zone: Health Checks Read', 'Account: Load Balancing: Monitors and Pools Read', 'Account: Cloudflare Tunnel Read', 'Zone: Waiting Rooms Read'],
    description: 'Health checks, load-balancer pools, tunnels and waiting rooms, with their current status.' },
  { id: 'platform', label: 'Developer platform', perm: 'runs:read', needs: ['Account: Workers Scripts Read', 'Account: Cloudflare Pages Read', 'Account: Workers R2 Storage Read', 'Account: Workers KV Storage Read', 'Account: D1 Read', 'Account: Queues Read'],
    description: 'Workers, Pages projects, R2 buckets, KV namespaces, D1 databases and queues in each account.' },
  { id: 'appsec', label: 'Scripts & APIs', perm: 'runs:read', needs: ['Zone: Page Shield Read', 'Zone: API Gateway Read'],
    description: 'Third-party scripts and connections Page Shield sees on your pages, and the API endpoints API Shield knows.' },
  { id: 'pagerules', label: 'Page Rules', perm: 'runs:read', needs: ['Zone: Page Rules Read'],
    description: 'Page Rules still in use, and the modern rule each one should move to before Cloudflare retires them.' },
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

export interface ReportSection {
  key: string;
  title: string;
  description?: string;
  columns: Column[];
  rows: Row[];
  /** Shown when there are no rows. */
  empty?: string;
}

export interface ReportStat { label: string; value: string | number; tone?: 'ok' | 'warn' | 'bad' | 'signal' }

/** A read that failed: which account or zone, and Cloudflare's reason. */
export interface ReportProblem { scope: string; error: string }

export interface MonitorReport {
  check: CheckId;
  generatedAt: string;
  durationMs: number;
  stats: ReportStat[];
  sections: ReportSection[];
  problems: ReportProblem[];
  /** Read only part of what it should (rate limit, a failed account). */
  partial?: boolean;
}

/** GET /api/monitors/{check}: the stored report and the check's open findings. */
export interface CheckView {
  meta: CheckMeta;
  report: MonitorReport | null;
  findings: Finding[];
  ranAt: string | null;
  error: string | null;
}

/** GET /api/monitors: every check at a glance. */
export interface MonitorOverview {
  checks: { meta: CheckMeta; ranAt: string | null; error: string | null; open: Record<Severity, number>; partial: boolean }[];
  findings: Finding[];
  schedule: { intervalHours: number; lastRunAt: string | null; nextRunAt: string | null; running: boolean };
}
