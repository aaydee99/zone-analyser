import 'server-only';
import { db } from '../supabase';
import { HttpError } from '../http';
import { SEVERITY_RANK, type AuditListItem, type AuditReport, type AuditStatus, type AuditSummary, type AuditView } from './types';

// Stored security audits (supabase/migrations/0021_zone_audits.sql): one row per audit, with its
// summary and report. zone_audit_start refuses a second audit of a zone while one runs and keeps the
// newest 20 per zone; zone_audit_latest pages the newest audit of every zone.

export const AUDITS_NOT_SET_UP = 'Security audits are not set up in the database yet: run supabase/migrations/0021_zone_audits.sql in the Supabase SQL editor, then reload this page';
/** A running audit older than this stopped with its worker (the SQL function uses the same limit). */
export const STALE_MS = 15 * 60_000;

/** A missing table or function (the migration not applied) is a clear 503. */
export function mustA<T>(res: { data: T; error: { message: string; code?: string } | null }, what = 'Database request'): T {
  if (!res.error) return res.data;
  const { code, message } = res.error;
  if (code === '42P01' || code === '42883' || code === '42703' || code === 'PGRST205' || code === 'PGRST202' || /does not exist|schema cache/i.test(message)) throw new HttpError(503, AUDITS_NOT_SET_UP);
  throw new Error(`${what} failed: ${message}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);
export const ZONE = /^[A-Za-z0-9_-]{1,64}$/;

interface Row {
  id: string; zone_id: string; zone_name: string; account_id: string | null; started_by: string | null; started_at: string; finished_at: string | null;
  status: AuditStatus; hours?: number; summary?: AuditSummary | null; report?: AuditReport | null; error?: string | null;
}
const LIST = 'id, zone_id, zone_name, account_id, started_by, started_at, finished_at, status, hours, summary, error';

function toItem(r: Row): AuditListItem & { hours: number; error: string | null } {
  // A running audit whose worker stopped: shown as failed (the next start marks it so in the table).
  const stale = r.status === 'running' && Date.now() - Date.parse(r.started_at) > STALE_MS;
  return {
    id: r.id, zoneId: r.zone_id, zoneName: r.zone_name, accountId: r.account_id, startedBy: r.started_by, startedAt: r.started_at, finishedAt: r.finished_at,
    status: stale ? 'failed' : r.status, summary: r.summary ?? null, hours: r.hours ?? 168,
    error: stale ? 'The audit stopped before it finished (the worker restarted) — run it again' : r.error ?? null,
  };
}

/** Starts an audit row (status running), or null when one of the zone is running already. */
export async function startAudit(z: { zoneId: string; zoneName: string; accountId: string | null }, by: string | null, hours: number) {
  const rows = mustA(await db().rpc('zone_audit_start', { p_zone: z.zoneId, p_zone_name: z.zoneName, p_account: z.accountId, p_by: by, p_hours: hours }), 'Starting the audit') as Row[] | null;
  return rows?.[0] ? toItem(rows[0]) : null;
}

/** Stores the finished report (or the error). */
export async function finishAudit(id: string, out: { report: AuditReport } | { error: string; summary?: AuditSummary }) {
  const now = new Date().toISOString();
  const patch = 'report' in out
    ? { status: 'ready', finished_at: now, report: out.report, summary: out.report.summary, worst_rank: out.report.summary.worst ? SEVERITY_RANK[out.report.summary.worst] : null, error: null }
    : { status: 'failed', finished_at: now, error: out.error.slice(0, 500), summary: out.summary ?? null };
  mustA(await db().from('zone_audits').update(patch).eq('id', id), 'Saving the audit');
}

export async function getAudit(id: string): Promise<(AuditView & { hours: number; error: string | null }) | null> {
  if (!isUuid(id)) return null;
  const row = mustA(await db().from('zone_audits').select(`${LIST}, report`).eq('id', id).maybeSingle(), 'Reading the audit') as Row | null;
  return row ? { ...toItem(row), report: row.report ?? null } : null;
}

/** A zone's audits, newest first (at most 20 are kept). */
export async function zoneHistory(zoneId: string) {
  if (!ZONE.test(zoneId)) return [];
  const rows = mustA(await db().from('zone_audits').select(LIST).eq('zone_id', zoneId).order('started_at', { ascending: false }).limit(20), 'Reading the audits') as Row[];
  return rows.map(toItem);
}

export type LatestSort = 'worst' | 'newest' | 'name';
/** The newest audit of every zone, one page. */
export async function latestAudits(o: { q: string; sort: LatestSort; offset: number; limit: number }) {
  const rows = mustA(await db().rpc('zone_audit_latest', { p_q: o.q, p_sort: o.sort, p_offset: o.offset, p_limit: o.limit }), 'Reading the audits') as (Row & { total: number })[] | null;
  const list = rows ?? [];
  return { audits: list.map(toItem), total: Number(list[0]?.total ?? 0) };
}
