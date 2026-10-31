import 'server-only';
import { db } from './supabase';
import { HttpError } from './http';
import {
  SPAN_MS, headlineOf, nextRunAt, type CleanDefinition, type ReportChannel, type ReportContent, type ReportDefinition, type ReportRun, type ReportRunSummary,
} from './report-types';

// Report definitions and the reports made from them (supabase/migrations/0020_reports.sql). A due
// report is taken with report_claim (one worker only), a run goes to each channel once
// (report_claim_delivery), and each report keeps its newest 50 runs.

export const REPORTS_NOT_SET_UP = 'Reports are not set up in the database yet: run supabase/migrations/0020_reports.sql in the Supabase SQL editor, then reload this page';

/** A missing table or function (the migration not applied) is a clear 503. */
export function mustR<T>(res: { data: T; error: { message: string; code?: string } | null }, what = 'Database request'): T {
  if (!res.error) return res.data;
  const { code, message } = res.error;
  if (code === '42P01' || code === '42883' || code === '42703' || code === 'PGRST205' || code === 'PGRST202' || /does not exist|schema cache/i.test(message)) throw new HttpError(503, REPORTS_NOT_SET_UP);
  throw new Error(`${what} failed: ${message}`);
}

interface DefRow {
  id: string; name: string; scope_kind: ReportDefinition['scope']; scope_accounts: string[] | null; scope_tags: string[] | null; cadence: ReportDefinition['cadence'];
  weekday: number | null; hour: number; sections: string[] | null; channels: string[] | null; enabled: boolean; next_run_at: string | null; last_run_at: string | null;
  created_at: string; created_by: string | null; updated_at: string; updated_by: string | null;
}
const DEF_COLUMNS = 'id, name, scope_kind, scope_accounts, scope_tags, cadence, weekday, hour, sections, channels, enabled, next_run_at, last_run_at, created_at, created_by, updated_at, updated_by';
const toDef = (r: DefRow): ReportDefinition => ({
  id: r.id, name: r.name, scope: r.scope_kind, accounts: r.scope_accounts ?? [], tags: r.scope_tags ?? [], cadence: r.cadence, weekday: r.weekday, hour: r.hour,
  sections: (r.sections ?? []) as ReportDefinition['sections'], channels: (r.channels ?? []) as ReportChannel[], enabled: r.enabled,
  nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
});

interface RunRow {
  id: string; definition_id: string; trigger: ReportRunSummary['trigger']; requested_by: string | null; status: ReportRunSummary['status'];
  period_start: string; period_end: string; since: string; started_at: string; finished_at: string | null; error: string | null;
  deliveries: ReportRunSummary['deliveries'] | null; content?: ReportContent | null;
}
const RUN_SUMMARY = 'id, definition_id, trigger, requested_by, status, period_start, period_end, since, started_at, finished_at, error, deliveries';
const toRun = (r: RunRow): ReportRunSummary => ({
  id: r.id, definitionId: r.definition_id, trigger: r.trigger, requestedBy: r.requested_by, status: r.status, periodStart: r.period_start, periodEnd: r.period_end,
  since: r.since, startedAt: r.started_at, finishedAt: r.finished_at, error: r.error, deliveries: r.deliveries ?? {},
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);

const toColumns = (d: CleanDefinition) => ({
  name: d.name, scope_kind: d.scope, scope_accounts: d.accounts, scope_tags: d.tags, cadence: d.cadence, weekday: d.weekday, hour: d.hour,
  sections: d.sections, channels: d.channels, enabled: d.enabled,
  next_run_at: d.enabled ? nextRunAt(d.cadence, d.hour, d.weekday, new Date()).toISOString() : null,
});

/** One page of report definitions, by name. */
export async function listDefinitions(offset: number, limit: number): Promise<{ definitions: ReportDefinition[]; total: number }> {
  const res = await db().from('report_definitions').select(DEF_COLUMNS, { count: 'exact' }).order('name', { ascending: true }).order('id', { ascending: true }).range(offset, offset + limit - 1);
  const rows = mustR(res, 'Reading reports') as DefRow[];
  return { definitions: rows.map(toDef), total: res.count ?? rows.length };
}

export async function getDefinition(id: string): Promise<ReportDefinition | null> {
  if (!isUuid(id)) return null;
  const row = mustR(await db().from('report_definitions').select(DEF_COLUMNS).eq('id', id).maybeSingle(), 'Reading the report') as DefRow | null;
  return row ? toDef(row) : null;
}

export async function createDefinition(d: CleanDefinition, by: string): Promise<ReportDefinition> {
  const rows = mustR(await db().from('report_definitions').insert({ ...toColumns(d), created_by: by, updated_by: by }).select(DEF_COLUMNS), 'Saving the report') as DefRow[];
  return toDef(rows[0]);
}

/** Saves new settings; the next run is worked out again from them. */
export async function updateDefinition(id: string, d: CleanDefinition, by: string): Promise<ReportDefinition | null> {
  if (!isUuid(id)) return null;
  const rows = mustR(await db().from('report_definitions').update({ ...toColumns(d), updated_by: by, updated_at: new Date().toISOString() }).eq('id', id).select(DEF_COLUMNS), 'Saving the report') as DefRow[];
  return rows[0] ? toDef(rows[0]) : null;
}

export async function deleteDefinition(id: string): Promise<ReportDefinition | null> {
  if (!isUuid(id)) return null;
  const rows = mustR(await db().from('report_definitions').delete().eq('id', id).select(DEF_COLUMNS), 'Deleting the report') as DefRow[];
  return rows[0] ? toDef(rows[0]) : null;
}

/** The newest run of each of these reports (for the list). */
export async function latestRuns(ids: string[]): Promise<Map<string, ReportRunSummary>> {
  const out = new Map<string, ReportRunSummary>();
  if (!ids.length) return out;
  // One query for the page (≤ 200 reports), not one per report.
  const rows = mustR(await db().rpc('report_latest', { p_ids: ids }), 'Reading reports') as RunRow[] | null;
  for (const r of rows ?? []) out.set(r.definition_id, toRun(r));
  return out;
}

/** A report's runs, newest first (with each one's headline). */
export async function listRuns(definitionId: string, offset: number, limit: number): Promise<{ runs: ReportRunSummary[]; total: number }> {
  const res = await db().from('report_runs').select(`${RUN_SUMMARY}, content`, { count: 'exact' }).eq('definition_id', definitionId)
    .order('started_at', { ascending: false }).range(offset, offset + limit - 1);
  const rows = mustR(res, 'Reading report history') as RunRow[];
  return { runs: rows.map((r) => ({ ...toRun(r), headline: headlineOf(r.content ?? null) })), total: res.count ?? rows.length };
}

export async function getRun(id: string): Promise<ReportRun | null> {
  if (!isUuid(id)) return null;
  const row = mustR(await db().from('report_runs').select(`${RUN_SUMMARY}, content`).eq('id', id).maybeSingle(), 'Reading the report') as RunRow | null;
  return row ? { ...toRun(row), content: row.content ?? null } : null;
}

// ── Running ─────────────────────────────────────────────────────────────────

/** Reports due now (enabled, next run in the past), oldest first. */
export async function dueDefinitions(limit = 10): Promise<ReportDefinition[]> {
  const rows = mustR(await db().from('report_definitions').select(DEF_COLUMNS).eq('enabled', true).lte('next_run_at', new Date().toISOString())
    .order('next_run_at', { ascending: true }).limit(limit), 'Reading due reports') as DefRow[];
  return rows.map(toDef);
}

const span = (d: ReportDefinition) => `${Math.round(SPAN_MS[d.cadence] / 1000)} seconds`;

/**
 * Takes a due report for this worker: moves its next run on and starts a run, only if no other
 * worker did first. A report whose worker was away is made once (for the period up to now), not
 * once per missed slot.
 */
export async function claimDue(d: ReportDefinition, owner: string): Promise<ReportRunSummary | null> {
  if (!d.nextRunAt) return null;
  const next = nextRunAt(d.cadence, d.hour, d.weekday, new Date());
  const rows = mustR(await db().rpc('report_claim', { p_id: d.id, p_due: d.nextRunAt, p_next: next.toISOString(), p_owner: owner, p_span: span(d) }), 'Taking a due report') as RunRow[] | null;
  return rows?.[0] ? toRun(rows[0]) : null;
}

/** A run asked for by hand; null while one of the same report is still being made. */
export async function startManual(d: ReportDefinition, by: string, owner: string): Promise<ReportRunSummary | null> {
  const rows = mustR(await db().rpc('report_start', { p_id: d.id, p_by: by, p_owner: owner, p_span: span(d) }), 'Starting the report') as RunRow[] | null;
  return rows?.[0] ? toRun(rows[0]) : null;
}

export async function finishRun(id: string, r: { content: ReportContent } | { error: string }) {
  const patch = 'content' in r
    ? { status: 'ready', content: r.content, finished_at: new Date().toISOString() }
    : { status: 'failed', error: r.error.slice(0, 500), finished_at: new Date().toISOString() };
  mustR(await db().from('report_runs').update(patch).eq('id', id).eq('status', 'running'), 'Saving the report');
}

/** Runs whose worker stopped while making them: marked failed (never made or sent again). */
export async function failStale(olderThanMs = 30 * 60_000) {
  mustR(await db().from('report_runs').update({ status: 'failed', error: 'The worker stopped before the report was finished', finished_at: new Date().toISOString() })
    .eq('status', 'running').lt('started_at', new Date(Date.now() - olderThanMs).toISOString()), 'Closing unfinished reports');
}

/** True the first time a channel of a run is taken for sending; false ever after. */
export async function claimDelivery(runId: string, channel: ReportChannel): Promise<boolean> {
  const rows = mustR(await db().rpc('report_claim_delivery', { p_run: runId, p_channel: channel }), 'Taking the report for sending') as { claimed: boolean }[] | null;
  return !!rows?.[0]?.claimed;
}

export async function saveDelivery(runId: string, channel: ReportChannel, ok: boolean, error: string | null) {
  mustR(await db().rpc('report_delivered', { p_run: runId, p_channel: channel, p_ok: ok, p_error: error }), 'Saving how the report was sent');
}

/** The accounts monitoring knows, for the scope picker. */
export async function knownAccounts(): Promise<{ id: string; name: string; zones: number }[]> {
  const rows = mustR(await db().rpc('report_accounts'), 'Reading accounts') as { account_id: string; account_name: string | null; zones: number }[] | null;
  return (rows ?? []).map((r) => ({ id: r.account_id, name: r.account_name || r.account_id, zones: Number(r.zones) || 0 }));
}
