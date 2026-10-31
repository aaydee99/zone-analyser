import 'server-only';
import { db } from './supabase';
import { HttpError } from './http';
import type { CheckId } from './monitor-types';

// Stored monitoring rows filtered by their fields (monitor_rows_filtered and friends, in
// supabase/migrations/0018_zone_health.sql): the Lists and Onboarding pages, and the checks that read
// what another of their units stored. Indexed by account, list, kind and status.

export const ROWS_NOT_SET_UP = 'This page needs supabase/migrations/0018_zone_health.sql: run it in the Supabase SQL editor (after 0010–0012), then reload this page';

export function must18<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (!res.error) return res.data;
  const { code, message } = res.error;
  if (code === '42P01' || code === '42883' || code === 'PGRST202' || code === 'PGRST205' || /does not exist|schema cache/i.test(message)) throw new HttpError(503, ROWS_NOT_SET_UP);
  throw new Error(`${what} failed: ${message}`);
}

export interface RowFilter { account?: string; list?: string; kind?: string; statusNot?: string; q?: string; offset?: number; limit?: number }

/** One page of a section's stored rows, with the total that match. */
export async function filteredRows<T = Record<string, unknown>>(check: CheckId, section: string, f: RowFilter = {}): Promise<{ rows: T[]; total: number }> {
  const q = (f.q ?? '').toLowerCase().replace(/[%_*,()\\]/g, ' ').trim().slice(0, 100);
  const res = must18(await db().rpc('monitor_rows_filtered', {
    p_check: check, p_section: section, p_account: f.account || null, p_list: f.list || null, p_kind: f.kind || null,
    p_status_not: f.statusNot || null, p_q: q || null, p_offset: f.offset ?? 0, p_limit: f.limit ?? 50,
  }), 'Reading stored rows') as { data: T; total: number }[] | null;
  return { rows: (res ?? []).map((r) => r.data), total: Number(res?.[0]?.total ?? 0) };
}

export async function rowAccounts(check: CheckId, section: string): Promise<{ id: string; name: string }[]> {
  const res = must18(await db().rpc('monitor_rows_accounts', { p_check: check, p_section: section }), 'Reading stored rows') as { account_id: string; account_name: string | null }[] | null;
  return (res ?? []).map((r) => ({ id: r.account_id, name: r.account_name || r.account_id }));
}

/** The DNSSEC status in a zone's newest drift snapshot, and when it was taken (null: none). */
export async function snapshotDnssec(zoneId: string): Promise<{ dnssec: string; takenAt: string } | null> {
  const res = await db().rpc('monitor_snapshot_dnssec', { p_zone: zoneId });
  if (res.error) return null;
  const r = (res.data as { dnssec: string; taken_at: string }[] | null)?.[0];
  return r ? { dnssec: r.dnssec, takenAt: r.taken_at } : null;
}
