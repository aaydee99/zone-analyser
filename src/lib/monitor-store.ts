import 'server-only';
import crypto from 'node:crypto';
import { db, must } from './supabase';
import type { CheckId, Finding, MonitorReport, Severity } from './monitor-types';

// Stored results of the monitoring checks (supabase/migrations/0010_monitoring.sql).

export interface NewFinding {
  /** Names the same problem across runs (for example "cert:<zone>:<pack id>"). */
  key: string;
  severity: Severity;
  title: string;
  detail?: string;
  accountId?: string;
  accountName?: string;
  zoneId?: string;
  zoneName?: string;
}

const idOf = (check: CheckId, key: string) => crypto.createHash('sha256').update(`${check}\n${key}`).digest('hex').slice(0, 24);

interface FindingRow {
  id: string; check_id: string; severity: Severity; title: string; detail: string;
  account_id: string | null; account_name: string | null; zone_id: string | null; zone_name: string | null;
  first_seen: string; last_seen: string; resolved_at: string | null; dismissed_at: string | null; dismissed_by: string | null; notified_at: string | null;
}

const toFinding = (r: FindingRow): Finding => ({
  id: r.id, check: r.check_id as CheckId, severity: r.severity, title: r.title, detail: r.detail,
  accountId: r.account_id, accountName: r.account_name, zoneId: r.zone_id, zoneName: r.zone_name,
  firstSeen: r.first_seen, lastSeen: r.last_seen, resolvedAt: r.resolved_at, dismissedAt: r.dismissed_at, dismissedBy: r.dismissed_by, notifiedAt: r.notified_at,
});

// ── Reports ─────────────────────────────────────────────────────────────────

export async function saveReport(check: CheckId, report: MonitorReport | null, error: string | null) {
  const row: Record<string, unknown> = { check_id: check, ran_at: new Date().toISOString(), duration_ms: report?.durationMs ?? 0, error };
  if (report) row.data = report;
  else {
    // A failed run keeps the last good report, with the error beside it.
    const prev = must(await db().from('monitor_reports').select('data').eq('check_id', check).maybeSingle(), 'Reading a check result');
    row.data = (prev as { data?: unknown } | null)?.data ?? {};
  }
  must(await db().from('monitor_reports').upsert(row), 'Saving a check result');
}

export async function readReport(check: CheckId): Promise<{ report: MonitorReport | null; ranAt: string | null; error: string | null }> {
  const row = must(await db().from('monitor_reports').select('data, ran_at, error').eq('check_id', check).maybeSingle(), 'Reading a check result') as { data: MonitorReport | Record<string, never>; ran_at: string; error: string | null } | null;
  if (!row) return { report: null, ranAt: null, error: null };
  return { report: 'check' in row.data ? row.data as MonitorReport : null, ranAt: row.ran_at, error: row.error };
}

export async function readAllReports(): Promise<{ check: CheckId; ranAt: string; error: string | null; partial: boolean }[]> {
  const rows = must(await db().from('monitor_reports').select('check_id, ran_at, error, data'), 'Reading check results') as { check_id: CheckId; ran_at: string; error: string | null; data: Partial<MonitorReport> }[];
  return rows.map((r) => ({ check: r.check_id, ranAt: r.ran_at, error: r.error, partial: !!r.data?.partial }));
}

// ── Findings ────────────────────────────────────────────────────────────────

/**
 * Records what one run of `check` found. New problems are added; ones seen before get a new
 * `last_seen` (and come back if they had been resolved). An open finding the run did not see again
 * is resolved — but only when the run read its account or zone (`read`), so a failed read never
 * closes a real problem. Returns the findings that are new or came back, for notifications.
 */
export async function syncFindings(check: CheckId, found: NewFinding[], read: Set<string>): Promise<Finding[]> {
  const now = new Date().toISOString();
  const byId = new Map(found.map((f) => [idOf(check, f.key), f]));
  const open = must(await db().from('monitor_findings').select('*').eq('check_id', check).is('resolved_at', null), 'Reading findings') as FindingRow[];
  const ids = [...byId.keys()];
  const known: FindingRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    known.push(...must(await db().from('monitor_findings').select('*').in('id', ids.slice(i, i + 200)), 'Reading findings') as FindingRow[]);
  }
  const prev = new Map(known.map((r) => [r.id, r]));
  const rows: FindingRow[] = [];
  const fresh: Finding[] = [];
  for (const [id, f] of byId) {
    const p = prev.get(id);
    const row: FindingRow = {
      id, check_id: check, severity: f.severity, title: f.title.slice(0, 300), detail: (f.detail ?? '').slice(0, 2000),
      account_id: f.accountId ?? null, account_name: f.accountName ?? null, zone_id: f.zoneId ?? null, zone_name: f.zoneName ?? null,
      first_seen: p && !p.resolved_at ? p.first_seen : now, last_seen: now, resolved_at: null,
      dismissed_at: p?.dismissed_at ?? null, dismissed_by: p?.dismissed_by ?? null,
      // A problem that comes back after it was resolved is news again.
      notified_at: p && !p.resolved_at ? p.notified_at : null,
    };
    rows.push(row);
    if (!p || p.resolved_at) fresh.push(toFinding(row));
  }
  for (let i = 0; i < rows.length; i += 200) must(await db().from('monitor_findings').upsert(rows.slice(i, i + 200)), 'Saving findings');
  const gone = open.filter((r) => !byId.has(r.id) && ((r.zone_id && read.has(r.zone_id)) || (!r.zone_id && r.account_id && read.has(r.account_id)) || (!r.zone_id && !r.account_id && read.has('*'))));
  for (let i = 0; i < gone.length; i += 200) {
    must(await db().from('monitor_findings').update({ resolved_at: now }).in('id', gone.slice(i, i + 200).map((r) => r.id)), 'Resolving findings');
  }
  return fresh;
}

export async function listFindings(opts: { check?: CheckId; resolved?: boolean; limit?: number } = {}): Promise<Finding[]> {
  let q = db().from('monitor_findings').select('*');
  if (opts.check) q = q.eq('check_id', opts.check);
  q = opts.resolved ? q.not('resolved_at', 'is', null) : q.is('resolved_at', null);
  const rows = must(await q.order('last_seen', { ascending: false }).limit(opts.limit ?? 2000), 'Reading findings') as FindingRow[];
  return rows.map(toFinding);
}

export async function setDismissed(id: string, by: string | null): Promise<Finding | null> {
  const rows = must(await db().from('monitor_findings').update({ dismissed_at: by ? new Date().toISOString() : null, dismissed_by: by }).eq('id', id).select('*'), 'Saving the finding') as FindingRow[];
  return rows[0] ? toFinding(rows[0]) : null;
}

export async function markNotified(ids: string[]) {
  const at = new Date().toISOString();
  for (let i = 0; i < ids.length; i += 200) must(await db().from('monitor_findings').update({ notified_at: at }).in('id', ids.slice(i, i + 200)), 'Saving notified findings');
}

// ── Alerts Cloudflare sent ──────────────────────────────────────────────────

export interface CloudflareAlert { id: string; receivedAt: string; alertType: string | null; name: string | null; text: string | null; accountId: string | null; data: unknown }

export async function saveAlert(a: { alertType?: string; name?: string; text?: string; accountId?: string; data: unknown }) {
  must(await db().from('cloudflare_alerts').insert({ alert_type: a.alertType ?? null, name: a.name ?? null, text: a.text ?? null, account_id: a.accountId ?? null, data: a.data }), 'Saving the alert');
}

export async function listAlerts(limit = 200): Promise<CloudflareAlert[]> {
  const rows = must(await db().from('cloudflare_alerts').select('*').order('received_at', { ascending: false }).limit(limit), 'Reading alerts') as { id: string; received_at: string; alert_type: string | null; name: string | null; text: string | null; account_id: string | null; data: unknown }[];
  return rows.map((r) => ({ id: r.id, receivedAt: r.received_at, alertType: r.alert_type, name: r.name, text: r.text, accountId: r.account_id, data: r.data }));
}

// ── Notifications sent ──────────────────────────────────────────────────────

export interface SentNotification { id: string; sentAt: string; channel: string; subject: string; findings: number; ok: boolean; error: string | null }

export async function logNotification(n: { channel: string; subject: string; findings: number; ok: boolean; error?: string | null }) {
  must(await db().from('notifications').insert({ channel: n.channel, subject: n.subject.slice(0, 300), findings: n.findings, ok: n.ok, error: n.error ?? null }), 'Saving the notification log');
}

export async function listNotifications(limit = 50): Promise<SentNotification[]> {
  const rows = must(await db().from('notifications').select('*').order('sent_at', { ascending: false }).limit(limit), 'Reading notifications') as { id: string; sent_at: string; channel: string; subject: string; findings: number; ok: boolean; error: string | null }[];
  return rows.map((r) => ({ id: r.id, sentAt: r.sent_at, channel: r.channel, subject: r.subject, findings: r.findings, ok: r.ok, error: r.error }));
}

/** Closes a check's open findings for these zones (drift accepted as the new baseline). */
export async function resolveForZones(check: CheckId, zoneIds: string[]) {
  const at = new Date().toISOString();
  for (let i = 0; i < zoneIds.length; i += 200) {
    must(await db().from('monitor_findings').update({ resolved_at: at }).eq('check_id', check).is('resolved_at', null).in('zone_id', zoneIds.slice(i, i + 200)), 'Resolving findings');
  }
}
