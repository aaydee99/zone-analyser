import 'server-only';
import { db } from './supabase';
import { HttpError } from './http';
import type { HealthAccount, HealthPage, HealthRow, HealthSort, HealthSummary } from './zone-health-types';
import { SEVERITIES } from './monitor-types';

// Zone health scores (supabase/migrations/0018_zone_health.sql): one 0–100 score per zone, kept up to
// date by triggers when monitoring saves a zone's result or a finding is dismissed or resolved. This
// module only reads the table — one indexed query a page — so the Health page never recomputes.

export const HEALTH_NOT_SET_UP = 'Zone health is not set up in the database yet: run supabase/migrations/0018_zone_health.sql in the Supabase SQL editor (after 0010–0012), then reload this page';

function mustHealth<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (!res.error) return res.data;
  const { code, message } = res.error;
  if (code === '42P01' || code === '42883' || code === 'PGRST202' || code === 'PGRST205' || /does not exist|schema cache/i.test(message)) throw new HttpError(503, HEALTH_NOT_SET_UP);
  throw new Error(`${what} failed: ${message}`);
}

interface Raw { zone_id: string; zone_name: string; account_id: string | null; account_name: string | null; score: number; open_findings: number; worst_rank: number; breakdown: HealthRow['breakdown']; computed_at: string; total?: number }

const RANKED = [...SEVERITIES].reverse(); // info … critical, by rank 0 … 4
const toRow = (r: Raw): HealthRow => ({
  zoneId: r.zone_id, zoneName: r.zone_name, accountId: r.account_id, accountName: r.account_name, score: Number(r.score), openFindings: Number(r.open_findings),
  worst: r.worst_rank >= 0 ? RANKED[r.worst_rank] ?? null : null, breakdown: r.breakdown ?? {}, computedAt: r.computed_at,
});

/** Zones carrying a tag (zone tags, src/lib/zone-meta.ts), or null when tags are not set up. */
async function zonesTagged(tag: string): Promise<string[] | null> {
  try {
    const meta = await import('./zone-meta');
    if (typeof meta.zoneIdsMatching !== 'function') return null;
    const ids = await meta.zoneIdsMatching({ tags: [tag] });
    return ids ? [...ids] : null;
  } catch (err) {
    if (err instanceof HttpError && err.status === 503) throw new HttpError(503, err.message);
    return null;
  }
}

export interface HealthQuery { account?: string; tag?: string; q?: string; sort?: HealthSort; offset?: number; limit?: number }

async function scope(o: HealthQuery): Promise<{ account: string | null; zones: string[] | null }> {
  const zones = o.tag ? await zonesTagged(o.tag) : null;
  if (o.tag && zones === null) throw new HttpError(400, 'Zone tags are not available on this console');
  return { account: o.account || null, zones };
}

export async function healthPage(o: HealthQuery): Promise<HealthPage> {
  const { account, zones } = await scope(o);
  const offset = Math.max(0, o.offset ?? 0), limit = Math.min(200, Math.max(1, o.limit ?? 50));
  if (zones && !zones.length) return { rows: [], total: 0, offset };
  const q = (o.q ?? '').toLowerCase().replace(/[%_\\]/g, '').trim().slice(0, 100);
  const rows = mustHealth(await db().rpc('zone_health_page', { p_account: account, p_zones: zones, p_q: q || null, p_sort: o.sort ?? 'score', p_offset: offset, p_limit: limit }), 'Reading zone health') as Raw[] | null;
  return { rows: (rows ?? []).map(toRow), total: Number(rows?.[0]?.total ?? 0), offset };
}

export async function healthSummary(o: Pick<HealthQuery, 'account' | 'tag'> = {}): Promise<HealthSummary> {
  const { account, zones } = await scope(o);
  if (zones && !zones.length) return { zones: 0, average: null, poor: 0, fair: 0, good: 0, computedAt: null };
  const r = (mustHealth(await db().rpc('zone_health_summary', { p_account: account, p_zones: zones }), 'Reading zone health') as { zones: number; average: string | number | null; poor: number; fair: number; good: number; computed_at: string | null }[] | null)?.[0];
  return { zones: Number(r?.zones ?? 0), average: r?.average == null ? null : Number(r.average), poor: Number(r?.poor ?? 0), fair: Number(r?.fair ?? 0), good: Number(r?.good ?? 0), computedAt: r?.computed_at ?? null };
}

export async function healthAccounts(): Promise<HealthAccount[]> {
  const rows = mustHealth(await db().rpc('zone_health_accounts'), 'Reading zone health') as { account_id: string; account_name: string | null; zones: number; average: string | number }[] | null;
  return (rows ?? []).map((r) => ({ id: r.account_id, name: r.account_name || r.account_id, zones: Number(r.zones), average: Number(r.average) }));
}
