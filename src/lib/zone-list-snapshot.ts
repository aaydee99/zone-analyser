import 'server-only';
import zlib from 'node:zlib';
import { db } from './supabase';
import type { ZoneList } from './zone-explorer';

// The last zone list read, kept in Supabase (zone_list_snapshot, supabase/migrations/0023_web_shared_reads.sql)
// so every server (each Vercel instance and the worker) starts from it instead of reading every zone
// of every account from Cloudflare again. It holds no tokens: credential IDs and names only. Without
// the migration, nothing is kept and each server reads the list itself, as before.

const g = globalThis as unknown as { __zoneSnapWarned?: boolean };
const warn = (why: string) => {
  if (g.__zoneSnapWarned) return;
  g.__zoneSnapWarned = true;
  console.warn(`[zone-list] not shared between servers: ${why} (is supabase/migrations/0023_web_shared_reads.sql applied?)`);
};

/** The stored list (with `at` = when it was read from Cloudflare), or null. */
export async function loadSnapshot(): Promise<ZoneList | null> {
  const { data, error } = await db().from('zone_list_snapshot').select('data, read_at').eq('id', 1).maybeSingle();
  if (error) { warn(error.message); return null; }
  const row = data as { data: string; read_at: string } | null;
  if (!row) return null;
  try {
    const list = JSON.parse(zlib.gunzipSync(Buffer.from(row.data, 'base64')).toString('utf8')) as ZoneList;
    return { ...list, at: Date.parse(row.read_at) };
  } catch (err) {
    console.warn('[zone-list] the stored list could not be read:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Stores a list just read. A list where every credential failed never replaces a stored one. */
export async function saveSnapshot(list: ZoneList): Promise<void> {
  if (!list.zones.length && list.problems.length) return;
  const data = zlib.gzipSync(Buffer.from(JSON.stringify(list))).toString('base64');
  const { error } = await db().rpc('zone_list_save', { p_data: data, p_zones: list.zones.length, p_read_at: new Date(list.at).toISOString() });
  if (error) warn(error.message);
}

/** True for the one server that should read the list again in the background now. */
export async function claimRefresh(): Promise<boolean> {
  const { data, error } = await db().rpc('zone_list_claim_refresh');
  if (error) { warn(error.message); return false; }
  return data === true;
}
