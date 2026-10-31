import 'server-only';
import crypto from 'node:crypto';
import { db } from './supabase';
import { HttpError } from './http';
import type { CheckId, Coverage, Finding, ReportProblem, Row, Severity } from './monitor-types';

// Stored results of the monitoring checks (supabase/migrations/0010_monitoring.sql and
// 0011_monitor_queue.sql, claims in 0012_monitor_claims.sql): one result and its table rows per check and zone or account, and the
// findings, each kept across runs under a stable id.

export type ScopeKind = 'zone' | 'account' | 'global';
export interface UnitKey { check: CheckId; kind: ScopeKind; id: string }

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

/** The monitoring tables are missing: say which migration to run instead of a bare 500. */
export const NOT_SET_UP = 'Monitoring is not set up in the database yet: run supabase/migrations/0010_monitoring.sql, 0011_monitor_queue.sql and 0012_monitor_claims.sql in the Supabase SQL editor, then reload this page';

/** Like supabase.must(), but a missing table or function (a migration not applied) is a clear 503. */
export function must<T>(res: { data: T; error: { message: string; code?: string } | null }, what = 'Database request'): T {
  if (!res.error) return res.data;
  const { code, message } = res.error;
  if (code === '42P01' || code === '42883' || code === '42703' || code === 'PGRST205' || code === 'PGRST202' || /does not exist|schema cache/i.test(message)) throw new HttpError(503, NOT_SET_UP);
  throw new Error(`${what} failed: ${message}`);
}

const CHUNK = 200;
const chunks = <T,>(list: T[], n = CHUNK) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// ── Results and rows ────────────────────────────────────────────────────────

const keyOf = (k: UnitKey) => ({ check_id: k.check, scope_kind: k.kind, scope_id: k.id });

/** What a unit kept from its last run. */
export async function readState(k: UnitKey): Promise<unknown> {
  const row = must(await db().from('monitor_results').select('state').eq('check_id', k.check).eq('scope_kind', k.kind).eq('scope_id', k.id).maybeSingle(), 'Reading a check result') as { state: unknown } | null;
  return row?.state ?? null;
}

/** The searchable text of a row: its shown values, lower-case. */
const searchText = (r: Row) => Object.entries(r).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined && v !== '').map(([, v]) => String(v)).join(' ').toLowerCase().slice(0, 2000);

/** Replaces a unit's result and its rows. */
export async function saveResult(k: UnitKey, r: { complete: boolean; problems: string[]; counts: Record<string, number>; state: unknown; durationMs: number }, rows: Partial<Record<string, Row[]>>) {
  must(await db().from('monitor_results').upsert({
    ...keyOf(k), ran_at: new Date().toISOString(), duration_ms: r.durationMs, complete: r.complete,
    problems: r.problems.slice(0, 20), counts: r.counts, state: r.state ?? null,
  }), 'Saving a check result');
  must(await db().from('monitor_rows').delete().eq('check_id', k.check).eq('scope_kind', k.kind).eq('scope_id', k.id), 'Saving check rows');
  const out = Object.entries(rows).flatMap(([section, list]) => (list ?? []).map((row) => {
    const { _sort, ...data } = row as Row & { _sort?: number };
    return { ...keyOf(k), section, sort: typeof _sort === 'number' && Number.isFinite(_sort) ? _sort : 0, data, search: searchText(data) };
  }));
  for (const part of chunks(out, 500)) must(await db().from('monitor_rows').insert(part), 'Saving check rows');
  // Zone search (src/lib/zone-search.ts): only queued here, indexed in the background.
  void import('./zone-search').then((m) => m.indexMonitorUnit(k, rows)).catch(() => {});
}

/** One page of a section's rows (sorted by the check; `q` searches every shown value). */
export async function listRows(check: CheckId, section: string, opts: { offset: number; limit: number; q?: string }): Promise<{ rows: Row[]; total: number }> {
  let q = db().from('monitor_rows').select('data', { count: 'exact' }).eq('check_id', check).eq('section', section);
  const term = (opts.q ?? '').toLowerCase().replace(/[%_*,()\\]/g, ' ').trim().slice(0, 100);
  if (term) q = q.ilike('search', `%${term}%`);
  const res = await q.order('sort', { ascending: true }).order('id', { ascending: true }).range(opts.offset, opts.offset + opts.limit - 1);
  const rows = must(res, 'Reading check rows') as { data: Row }[];
  return { rows: rows.map((r) => r.data), total: res.count ?? rows.length };
}

export async function countRows(check: CheckId, section: string): Promise<number> {
  const res = await db().from('monitor_rows').select('id', { count: 'exact', head: true }).eq('check_id', check).eq('section', section);
  must(res, 'Counting check rows');
  return res.count ?? 0;
}

/** Each check's counts, summed over its units. */
export async function totals(check: CheckId): Promise<Record<string, number>> {
  const rows = must(await db().rpc('monitor_totals', { p_check: check }), 'Reading check totals') as { key: string; total: number }[] | null;
  return Object.fromEntries((rows ?? []).map((r) => [r.key, Number(r.total) || 0]));
}

const emptyCoverage = (): Coverage => ({ targets: 0, read: 0, failing: 0, never: 0, due: 0, lastRun: null });

/** Every check's coverage. */
export async function coverage(): Promise<Map<CheckId, Coverage>> {
  const rows = must(await db().rpc('monitor_coverage'), 'Reading check coverage') as { check_id: CheckId; targets: number; read_ok: number; failing: number; never: number; due: number; last_run: string | null }[] | null;
  const out = new Map<CheckId, Coverage>();
  for (const r of rows ?? []) out.set(r.check_id, { targets: Number(r.targets), read: Number(r.read_ok), failing: Number(r.failing), never: Number(r.never), due: Number(r.due), lastRun: r.last_run });
  return out;
}
export const coverageOf = (m: Map<CheckId, Coverage>, c: CheckId) => m.get(c) ?? emptyCoverage();

/** The newest failed or partial reads of a check, with where they happened. */
export async function problems(check: CheckId, limit = 100): Promise<ReportProblem[]> {
  const rows = must(await db().from('monitor_targets').select('scope_kind, scope_id, account_name, zone_name, last_error, last_run_at').eq('check_id', check).not('last_error', 'is', null).order('last_run_at', { ascending: false }).limit(limit), 'Reading check problems') as { scope_kind: ScopeKind; scope_id: string; account_name: string | null; zone_name: string | null; last_error: string; last_run_at: string | null }[];
  return rows.map((r) => ({ scope: r.scope_kind === 'zone' ? r.zone_name || r.scope_id : r.scope_kind === 'account' ? r.account_name || `Account ${r.scope_id}` : 'All tokens', error: r.last_error, at: r.last_run_at ?? '' }));
}

// ── Findings ────────────────────────────────────────────────────────────────

const idOf = (check: CheckId, key: string) => crypto.createHash('sha256').update(`${check}\n${key}`).digest('hex').slice(0, 24);

interface FindingRow {
  id: string; check_id: string; severity: Severity; title: string; detail: string;
  account_id: string | null; account_name: string | null; zone_id: string | null; zone_name: string | null;
  first_seen: string; last_seen: string; resolved_at: string | null; dismissed_at: string | null; dismissed_by: string | null; notified_at: string | null;
}
const COLUMNS = 'id, check_id, severity, title, detail, account_id, account_name, zone_id, zone_name, first_seen, last_seen, resolved_at, dismissed_at, dismissed_by, notified_at';

const toFinding = (r: FindingRow): Finding => ({
  id: r.id, check: r.check_id as CheckId, severity: r.severity, title: r.title, detail: r.detail,
  accountId: r.account_id, accountName: r.account_name, zoneId: r.zone_id, zoneName: r.zone_name,
  firstSeen: r.first_seen, lastSeen: r.last_seen, resolvedAt: r.resolved_at, dismissedAt: r.dismissed_at, dismissedBy: r.dismissed_by, notifiedAt: r.notified_at,
});

/** A unit's open findings: those of its zone, its account (not of a zone in it), or the whole console. */
function openInScope(check: CheckId, kind: ScopeKind, id: string) {
  let q = db().from('monitor_findings').select(COLUMNS).eq('check_id', check).is('resolved_at', null);
  if (kind === 'zone') q = q.eq('zone_id', id);
  else if (kind === 'account') q = q.eq('account_id', id).is('zone_id', null);
  else q = q.is('account_id', null).is('zone_id', null);
  return q;
}

/**
 * Records what one unit found. New problems are added; ones seen before get a new `last_seen` (and
 * come back if they had been resolved). An open finding of the unit's scope that it did not find
 * again is resolved — but only when it read everything (`complete`), so a failed read never closes a
 * real problem. Returns the findings that are new or came back.
 */
export async function syncFindings(k: UnitKey, found: NewFinding[], complete: boolean): Promise<Finding[]> {
  const now = new Date().toISOString();
  const byId = new Map(found.map((f) => [idOf(k.check, f.key), f]));
  const known: FindingRow[] = [];
  for (const ids of chunks([...byId.keys()])) known.push(...must(await db().from('monitor_findings').select(COLUMNS).in('id', ids), 'Reading findings') as FindingRow[]);
  const prev = new Map(known.map((r) => [r.id, r]));
  // Findings still open are saved without their notification columns: a worker may be sending them
  // right now (notify.ts claims them by setting notified_at), and this must not undo that.
  const still: Omit<FindingRow, 'notified_at'>[] = [];
  const news: (FindingRow & { notified_channels: string[] })[] = [];
  const fresh: Finding[] = [];
  for (const [id, f] of byId) {
    const p = prev.get(id);
    const open = !!p && !p.resolved_at;
    const row: Omit<FindingRow, 'notified_at'> = {
      id, check_id: k.check, severity: f.severity, title: f.title.slice(0, 300), detail: (f.detail ?? '').slice(0, 2000),
      account_id: f.accountId ?? null, account_name: f.accountName ?? null, zone_id: f.zoneId ?? null, zone_name: f.zoneName ?? null,
      first_seen: open ? p.first_seen : now, last_seen: now, resolved_at: null,
      dismissed_at: p?.dismissed_at ?? null, dismissed_by: p?.dismissed_by ?? null,
    };
    if (open) { still.push(row); continue; }
    // New, or a problem that comes back after it was resolved: news again.
    news.push({ ...row, notified_at: null, notified_channels: [] });
    fresh.push(toFinding({ ...row, notified_at: null }));
  }
  for (const part of chunks(still)) must(await db().from('monitor_findings').upsert(part), 'Saving findings');
  for (const part of chunks(news)) must(await db().from('monitor_findings').upsert(part), 'Saving findings');
  if (complete) {
    const open = must(await openInScope(k.check, k.kind, k.id), 'Reading findings') as FindingRow[];
    const gone = open.filter((r) => !byId.has(r.id)).map((r) => r.id);
    for (const ids of chunks(gone)) must(await db().from('monitor_findings').update({ resolved_at: now }).in('id', ids), 'Resolving findings');
  }
  return fresh;
}

/** Zones or accounts the tokens no longer reach: their results go, their open findings close. */
export async function forgetUnits(check: CheckId, kind: ScopeKind, ids: string[]) {
  const now = new Date().toISOString();
  for (const part of chunks(ids)) {
    must(await db().from('monitor_rows').delete().eq('check_id', check).eq('scope_kind', kind).in('scope_id', part), 'Removing check rows');
    must(await db().from('monitor_results').delete().eq('check_id', check).eq('scope_kind', kind).in('scope_id', part), 'Removing check results');
    must(await db().from('monitor_targets').delete().eq('check_id', check).eq('scope_kind', kind).in('scope_id', part), 'Removing check targets');
    let q = db().from('monitor_findings').update({ resolved_at: now }).eq('check_id', check).is('resolved_at', null);
    q = kind === 'zone' ? q.in('zone_id', part) : q.in('account_id', part).is('zone_id', null);
    must(await q, 'Resolving findings');
    // Every zone has a drift unit: when that goes, the zone is gone, so it leaves the search index too
    // (0016_zone_search; without it there is nothing to remove).
    if (check === 'drift' && kind === 'zone') await db().rpc('zone_search_forget', { p_zones: part, p_source: null });
  }
}

/** `zoneIds`: only findings of these zones (a zone tag or owner filter, src/lib/zone-meta.ts); left out = every zone. */
export interface FindingQuery { checks: CheckId[]; severity?: Severity; dismissed?: boolean; q?: string; offset?: number; limit?: number; zoneIds?: string[] }

/** Open findings of the given checks, worst first, a page at a time. */
export async function listFindings(o: FindingQuery): Promise<{ findings: Finding[]; total: number }> {
  if (!o.checks.length) return { findings: [], total: 0 };
  if (o.zoneIds) return listZoneFindings(o, o.zoneIds);
  let q = db().from('monitor_findings').select(COLUMNS, { count: 'exact' }).in('check_id', o.checks).is('resolved_at', null);
  q = o.dismissed ? q.not('dismissed_at', 'is', null) : q.is('dismissed_at', null);
  if (o.severity) q = q.eq('severity', o.severity);
  const term = (o.q ?? '').replace(/[%_*,()\\]/g, ' ').trim().slice(0, 100);
  if (term) q = q.ilike('title', `%${term}%`);
  const offset = o.offset ?? 0, limit = o.limit ?? 100;
  const res = await q.order('severity_rank', { ascending: false }).order('last_seen', { ascending: false }).range(offset, offset + limit - 1);
  const rows = must(res, 'Reading findings') as FindingRow[];
  return { findings: rows.map(toFinding), total: res.count ?? rows.length };
}

/**
 * The same page limited to some zones: one call to zone_meta_findings (migration 0015) with the
 * ids in the request body — a tag can cover thousands of zones, more than a URL holds.
 */
async function listZoneFindings(o: FindingQuery, zoneIds: string[]): Promise<{ findings: Finding[]; total: number }> {
  if (!zoneIds.length) return { findings: [], total: 0 };
  const term = (o.q ?? '').replace(/[%_*,()\\]/g, ' ').trim().slice(0, 100);
  const res = await db().rpc('zone_meta_findings', {
    p_zone_ids: zoneIds, p_checks: o.checks, p_severity: o.severity ?? null, p_dismissed: !!o.dismissed, p_term: term,
    p_offset: o.offset ?? 0, p_limit: Math.min(200, Math.max(1, o.limit ?? 100)),
  });
  if (res.error && /zone_meta_findings|could not find the function/i.test(res.error.message)) {
    throw new HttpError(503, 'Filtering findings by zone tag needs supabase/migrations/0015_zone_meta.sql: run it in the Supabase SQL editor, then reload this page');
  }
  const row = (must(res, 'Reading findings') as { total: number; rows: FindingRow[] }[] | null)?.[0];
  return { findings: (row?.rows ?? []).map(toFinding), total: Number(row?.total ?? 0) };
}

/** Open, not dismissed findings per check and severity. */
export async function openCounts(): Promise<Map<CheckId, Record<Severity, number>>> {
  const rows = must(await db().rpc('monitor_open_counts'), 'Counting findings') as { check_id: CheckId; severity: Severity; n: number }[] | null;
  const out = new Map<CheckId, Record<Severity, number>>();
  for (const r of rows ?? []) {
    const c = out.get(r.check_id) ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    c[r.severity] = Number(r.n);
    out.set(r.check_id, c);
  }
  return out;
}
export const countsOf = (m: Map<CheckId, Record<Severity, number>>, c: CheckId): Record<Severity, number> => m.get(c) ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

/** Open findings not sent yet, found since `since`, at or above `minRank` (4 = critical … 0 = info). */
export async function unsentFindings(minRank: number, since: string, limit = 500): Promise<Finding[]> {
  const rows = must(await db().from('monitor_findings').select(COLUMNS).is('resolved_at', null).is('notified_at', null).is('dismissed_at', null)
    .gte('severity_rank', minRank).gte('first_seen', since).order('severity_rank', { ascending: false }).limit(limit), 'Reading findings to send') as FindingRow[];
  return rows.map(toFinding);
}

export async function setDismissed(id: string, by: string | null): Promise<Finding | null> {
  const rows = must(await db().from('monitor_findings').update({ dismissed_at: by ? new Date().toISOString() : null, dismissed_by: by }).eq('id', id).select(COLUMNS), 'Saving the finding') as FindingRow[];
  return rows[0] ? toFinding(rows[0]) : null;
}

/**
 * Claims findings for sending: sets notified_at, but only on findings no one claimed or sent yet,
 * so two workers never send the same one. Returns the claim's time and the findings won, each with
 * the channels it already went to (from an earlier, partly failed send).
 */
export async function claimForSending(ids: string[]): Promise<{ at: string; won: Map<string, string[]> }> {
  const at = new Date().toISOString();
  const won = new Map<string, string[]>();
  for (const part of chunks(ids)) {
    const rows = must(await db().from('monitor_findings').update({ notified_at: at }).in('id', part).is('notified_at', null).select('id, notified_channels'), 'Claiming findings to send') as { id: string; notified_channels: string[] | null }[];
    for (const r of rows) won.set(r.id, r.notified_channels ?? []);
  }
  return { at, won };
}

/** Records the channels each finding was delivered to (findings with the same channels in one update). */
export async function saveDelivered(channels: Map<string, string[]>) {
  const groups = new Map<string, string[]>();
  for (const [id, list] of channels) {
    const key = [...new Set(list)].sort().join(',');
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  for (const [key, ids] of groups) {
    for (const part of chunks(ids)) must(await db().from('monitor_findings').update({ notified_channels: key ? key.split(',') : [] }).in('id', part), 'Saving notified findings');
  }
}

/** Gives back findings claimed at `at` that did not reach every channel: the next round sends them again (to the channels they missed). */
export async function releaseClaim(ids: string[], at: string) {
  for (const part of chunks(ids)) must(await db().from('monitor_findings').update({ notified_at: null }).in('id', part).eq('notified_at', at), 'Saving notified findings');
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
