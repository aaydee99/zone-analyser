// Scheduled reports: shapes, the schedule and input checks shared by server and client — no Node imports.
// Stored in supabase/migrations/0020_reports.sql; made by the worker (src/lib/report-scheduler.ts).

import type { Severity } from './monitor-types';

export type ReportScope = 'all' | 'accounts' | 'tag';
export type Cadence = 'daily' | 'weekly';
export type ReportChannel = 'slack' | 'webhook';
export type SectionKey = 'changes' | 'findings' | 'traffic' | 'certificates' | 'coverage';

export const SECTIONS: { key: SectionKey; label: string; description: string }[] = [
  { key: 'changes', label: 'Configuration changes', description: 'Changes in the Cloudflare audit logs during the period, by category.' },
  { key: 'findings', label: 'Monitoring findings', description: 'Open findings by severity, and those found or resolved since the report before.' },
  { key: 'traffic', label: 'Traffic & security', description: 'Requests, bandwidth, cache and security events against the period before (read from Cloudflare when the report is made).' },
  { key: 'certificates', label: 'Expiring certificates', description: 'Certificates that expire within 30 days, or have expired, from the certificates check.' },
  { key: 'coverage', label: 'Coverage problems', description: 'Monitoring units that could not be read, or were never read.' },
];
export const SECTION_LABEL = Object.fromEntries(SECTIONS.map((s) => [s.key, s.label])) as Record<SectionKey, string>;
export const isSection = (v: unknown): v is SectionKey => SECTIONS.some((s) => s.key === v);

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const SPAN_MS: Record<Cadence, number> = { daily: 86_400_000, weekly: 7 * 86_400_000 };
/** History kept per report (older runs are deleted when a new one starts). */
export const KEEP_RUNS = 50;
/** Certificates with at most this many days left are listed. */
export const CERT_DAYS = 30;
/** Accounts whose traffic one report reads at most (one GraphQL query per account). */
export const MAX_TRAFFIC_ACCOUNTS = 200;
/** Zones whose traffic a tag report reads at most (zone-level queries, 10 zones each). */
export const MAX_TRAFFIC_ZONES = 100;

export interface ReportDefinition {
  id: string;
  name: string;
  scope: ReportScope;
  accounts: string[];
  tags: string[];
  cadence: Cadence;
  /** 0 = Sunday (weekly reports only). */
  weekday: number | null;
  /** UTC. */
  hour: number;
  sections: SectionKey[];
  channels: ReportChannel[];
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export type DeliveryState = { state: 'sending' | 'sent' | 'failed'; at: string; error?: string | null };

export interface ReportRunSummary {
  id: string;
  definitionId: string;
  trigger: 'schedule' | 'manual';
  requestedBy: string | null;
  status: 'running' | 'ready' | 'failed';
  periodStart: string;
  periodEnd: string;
  since: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  deliveries: Partial<Record<ReportChannel, DeliveryState>>;
  /** Short counts for the history list (from the content). */
  headline?: string | null;
}

export interface ReportRun extends ReportRunSummary { content: ReportContent | null }

// ── What a report holds ─────────────────────────────────────────────────────
// Every number is something that was read or counted; a section that could not be read says why
// (`unavailable`), and an empty one says so (`nothing`). Nothing is estimated.

export type SectionStatus = 'ok' | 'nothing' | 'unavailable';
export interface SectionBase { status: SectionStatus; note?: string }

export interface ChangesSection extends SectionBase {
  total: number;
  byCategory: { label: string; total: number; create: number; update: number; delete: number }[];
  /** The newest changes (at most 25). */
  top: { time: string; title: string; zone: string; account: string; actor: string }[];
  zoneEvents: { added: number; activated: number; removed: number };
  /** Accounts whose audit log could not be read, or was cut short. */
  problems: { account: string; error: string }[];
  readAt: string | null;
}

export type SevCounts = Record<Severity, number>;
export interface FindingLine { severity: Severity; check: string; title: string; where: string; at: string }
export interface FindingsSection extends SectionBase {
  open: SevCounts;
  fresh: SevCounts;
  resolved: SevCounts;
  freshTop: FindingLine[];
  resolvedTop: FindingLine[];
}

export interface TrafficNumbers { requests: number; cachedRequests: number; bytes: number; cachedBytes: number; pageViews: number }
export interface SecurityNumbers { events: number; byAction: { action: string; count: number }[] }
export interface TrafficSection extends SectionBase {
  /** Accounts (or zones, for a tag report) read, and those that could not be read. */
  read: number;
  of: number;
  unit: 'accounts' | 'zones';
  current: TrafficNumbers | null;
  previous: TrafficNumbers | null;
  security: SecurityNumbers | null;
  securityPrevious: SecurityNumbers | null;
  problems: { scope: string; error: string }[];
}

export interface CertLine { kind: string; name: string; where: string; status: string; expires: string | null; days: number | null }
export interface CertificatesSection extends SectionBase { total: number; rows: CertLine[] }

export interface CoverageSection extends SectionBase {
  checks: { check: string; label: string; targets: number; read: number; failing: number; never: number }[];
  problems: { check: string; scope: string; error: string; at: string | null }[];
}

export interface ReportContent {
  version: 1;
  name: string;
  cadence: Cadence;
  scope: { kind: ReportScope; label: string };
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  since: string;
  sections: {
    changes?: ChangesSection;
    findings?: FindingsSection;
    traffic?: TrafficSection;
    certificates?: CertificatesSection;
    coverage?: CoverageSection;
  };
}

// ── The schedule ────────────────────────────────────────────────────────────

/** The first time after `after` at `hour`:00 UTC (on `weekday` for a weekly report). */
export function nextRunAt(cadence: Cadence, hour: number, weekday: number | null, after: Date): Date {
  const d = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), hour, 0, 0, 0));
  if (cadence === 'daily') {
    if (d.getTime() <= after.getTime()) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  const wd = weekday ?? 1;
  d.setUTCDate(d.getUTCDate() + ((wd - d.getUTCDay() + 7) % 7));
  if (d.getTime() <= after.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}

/** "Every day at 07:00 UTC", "Every Monday at 07:00 UTC". */
export function scheduleLabel(d: Pick<ReportDefinition, 'cadence' | 'hour' | 'weekday'>) {
  const at = `${String(d.hour).padStart(2, '0')}:00 UTC`;
  return d.cadence === 'daily' ? `Every day at ${at}` : `Every ${WEEKDAYS[d.weekday ?? 1]} at ${at}`;
}

// ── Input ───────────────────────────────────────────────────────────────────

export interface DefinitionInput {
  name?: unknown; scope?: unknown; accounts?: unknown; tags?: unknown; cadence?: unknown; weekday?: unknown; hour?: unknown;
  sections?: unknown; channels?: unknown; enabled?: unknown;
}
export interface CleanDefinition {
  name: string; scope: ReportScope; accounts: string[]; tags: string[]; cadence: Cadence; weekday: number | null; hour: number;
  sections: SectionKey[]; channels: ReportChannel[]; enabled: boolean;
}

const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const TAG = /^[a-z0-9][a-z0-9:._/-]{0,63}$/;

/** Checks a report's settings; returns them clean, or the first problem. */
export function cleanDefinition(i: DefinitionInput): { ok: true; value: CleanDefinition } | { ok: false; error: string } {
  const name = typeof i.name === 'string' ? i.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
  if (!name) return { ok: false, error: 'Give the report a name' };
  if (name.length > 120) return { ok: false, error: 'The name is too long (120 characters at most)' };
  const scope = i.scope ?? 'all';
  if (scope !== 'all' && scope !== 'accounts' && scope !== 'tag') return { ok: false, error: 'scope must be all, accounts or tag' };
  const accounts = scope === 'accounts' ? [...new Set(Array.isArray(i.accounts) ? i.accounts.filter((a): a is string => typeof a === 'string').map((a) => a.trim().toLowerCase()) : [])] : [];
  if (scope === 'accounts' && !accounts.length) return { ok: false, error: 'Choose at least one account' };
  if (accounts.length > 200) return { ok: false, error: 'Choose at most 200 accounts' };
  if (accounts.some((a) => !ACCOUNT_ID.test(a))) return { ok: false, error: 'Not a Cloudflare account ID' };
  const rawTags = scope === 'tag' ? (Array.isArray(i.tags) ? i.tags : typeof i.tags === 'string' ? i.tags.split(/[,;\s]+/) : []) : [];
  const tags = [...new Set(rawTags.filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim().toLowerCase().replace(/\s+/g, '-')))].sort();
  if (scope === 'tag' && !tags.length) return { ok: false, error: 'Give at least one tag' };
  if (tags.length > 10) return { ok: false, error: 'Give at most 10 tags' };
  if (tags.some((t) => !TAG.test(t))) return { ok: false, error: 'A tag is letters, digits and : . _ / - (64 at most)' };
  const cadence = i.cadence ?? 'weekly';
  if (cadence !== 'daily' && cadence !== 'weekly') return { ok: false, error: 'cadence must be daily or weekly' };
  const hour = i.hour === undefined ? 7 : Number(i.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { ok: false, error: 'hour must be 0 to 23 (UTC)' };
  let weekday: number | null = null;
  if (cadence === 'weekly') {
    weekday = i.weekday === undefined || i.weekday === null ? 1 : Number(i.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { ok: false, error: 'weekday must be 0 (Sunday) to 6 (Saturday)' };
  }
  const sections = Array.isArray(i.sections) ? i.sections : SECTIONS.map((s) => s.key);
  if (!sections.every(isSection)) return { ok: false, error: 'Unknown section' };
  if (!sections.length) return { ok: false, error: 'Choose at least one section' };
  const channels = Array.isArray(i.channels) ? i.channels : [];
  if (!channels.every((c) => c === 'slack' || c === 'webhook')) return { ok: false, error: 'channels may be slack and webhook' };
  if (i.enabled !== undefined && typeof i.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  return {
    ok: true,
    value: {
      name, scope, accounts, tags, cadence, weekday, hour,
      sections: SECTIONS.map((s) => s.key).filter((k) => (sections as SectionKey[]).includes(k)),
      channels: (['slack', 'webhook'] as const).filter((c) => (channels as string[]).includes(c)),
      enabled: i.enabled === undefined ? true : (i.enabled as boolean),
    },
  };
}

// ── Numbers ─────────────────────────────────────────────────────────────────

export const sumCounts = (c: SevCounts | null | undefined) => (c ? Object.values(c).reduce((a, b) => a + b, 0) : 0);
export const emptyCounts = (): SevCounts => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

/** "+12.5%" / "−3.0%" / "new" / "" — the change from `before` to `now`; nothing when there is no earlier number. */
export function changeLabel(now: number, before: number | null | undefined): string {
  if (before === null || before === undefined) return '';
  if (before === 0) return now === 0 ? '0%' : 'new';
  const pct = ((now - before) / before) * 100;
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
}

/** "1.2 GB" for bytes. */
export function bytesLabel(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n, u = 0;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  return `${u ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** One line for the history list: what the report found, from its content. */
export function headlineOf(c: ReportContent | null): string | null {
  if (!c) return null;
  const parts: string[] = [];
  const s = c.sections;
  if (s.changes?.status === 'ok') parts.push(`${s.changes.total} change${s.changes.total === 1 ? '' : 's'}`);
  if (s.findings?.status === 'ok' || s.findings?.status === 'nothing') parts.push(`${sumCounts(s.findings.open)} open findings (${sumCounts(s.findings.fresh)} new)`);
  if (s.certificates && s.certificates.status !== 'unavailable') parts.push(`${s.certificates.total} expiring certificate${s.certificates.total === 1 ? '' : 's'}`);
  return parts.join(' · ') || null;
}
