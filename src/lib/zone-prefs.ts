import 'server-only';
import { db } from './supabase';
import { HttpError } from './http';
import { mustMeta } from './zone-meta';
import type { ZoneListItem } from './zone-catalog';
import { ZONE_ID } from './zone-meta-types';

// Each user's own shortcuts (supabase/migrations/0015_zone_meta.sql): starred zones, the last 20
// zones they opened, and named views (a page and its query string). Every query is keyed by the
// signed-in user's id, so nobody reads or changes another person's rows.

export interface QuickZone { zoneId: string; zoneName: string; accountName: string; at: string }
export interface SavedView { id: string; path: string; name: string; query: string; createdAt: string }

const MAX_FAVOURITES = 200;
const MAX_VIEWS = 100;
const RECENTS = 20;

interface ZoneRow { zone_id: string; zone_name: string; account_name: string; created_at?: string; visited_at?: string }
const toQuick = (r: ZoneRow): QuickZone => ({ zoneId: r.zone_id, zoneName: r.zone_name, accountName: r.account_name, at: r.created_at ?? r.visited_at ?? '' });

export async function quickZones(userId: string): Promise<{ favourites: QuickZone[]; recents: QuickZone[] }> {
  const [fav, rec] = await Promise.all([
    db().from('user_zone_favourites').select('zone_id, zone_name, account_name, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(MAX_FAVOURITES),
    db().from('user_zone_recents').select('zone_id, zone_name, account_name, visited_at').eq('user_id', userId).order('visited_at', { ascending: false }).limit(RECENTS),
  ]);
  return { favourites: (mustMeta(fav, 'Reading favourites') as ZoneRow[]).map(toQuick), recents: (mustMeta(rec, 'Reading recent zones') as ZoneRow[]).map(toQuick) };
}

export async function isFavourite(userId: string, zoneId: string): Promise<boolean> {
  const rows = mustMeta(await db().from('user_zone_favourites').select('zone_id').eq('user_id', userId).eq('zone_id', zoneId).limit(1), 'Reading favourites') as unknown[];
  return rows.length > 0;
}

export async function setFavourite(userId: string, zone: Pick<ZoneListItem, 'id' | 'name' | 'accountName'>, on: boolean): Promise<void> {
  if (!on) {
    mustMeta(await db().from('user_zone_favourites').delete().eq('user_id', userId).eq('zone_id', zone.id), 'Saving favourites');
    return;
  }
  const { count, error } = await db().from('user_zone_favourites').select('zone_id', { count: 'exact', head: true }).eq('user_id', userId);
  mustMeta({ data: null, error }, 'Reading favourites');
  if ((count ?? 0) >= MAX_FAVOURITES) throw new HttpError(400, `At most ${MAX_FAVOURITES} favourite zones — unstar one first`);
  mustMeta(await db().from('user_zone_favourites').upsert({ user_id: userId, zone_id: zone.id, zone_name: zone.name, account_name: zone.accountName }, { onConflict: 'user_id,zone_id', ignoreDuplicates: true }), 'Saving favourites');
}

const gw = globalThis as unknown as { __recentWarned?: boolean };

/** Records that the user opened a zone. Fire and forget: never throws, never delays the page. */
export function touchRecent(userId: string, zone: Pick<ZoneListItem, 'id' | 'name' | 'accountName'>): void {
  if (!ZONE_ID.test(zone.id)) return;
  void Promise.resolve().then(async () => {
    const { error } = await db().rpc('zone_recent_touch', { p_user: userId, p_zone: zone.id, p_name: zone.name, p_account: zone.accountName });
    if (error && !gw.__recentWarned) { gw.__recentWarned = true; console.warn(`[zone-prefs] recent zones not recorded: ${error.message} (is supabase/migrations/0015_zone_meta.sql applied?)`); }
  }).catch(() => {});
}

// ── Saved views ─────────────────────────────────────────────────────────────

/** A console page path. */
const PATH = /^\/console(\/[A-Za-z0-9._~-]+)*$/;

interface ViewRow { id: string; path: string; name: string; query: string; created_at: string }
const toView = (r: ViewRow): SavedView => ({ id: r.id, path: r.path, name: r.name, query: r.query, createdAt: r.created_at });

export function checkPath(raw: unknown): string {
  const p = typeof raw === 'string' ? raw.trim() : '';
  if (!PATH.test(p) || p.length > 200) throw new HttpError(400, 'Not a console page');
  return p;
}

/** The query string as kept: without "?", re-encoded, at most 2,000 characters. */
export function checkQuery(raw: unknown): string {
  const q = new URLSearchParams(typeof raw === 'string' ? raw.replace(/^\?/, '') : '');
  q.sort();
  const s = q.toString();
  if (s.length > 2000) throw new HttpError(400, 'This view is too long to save');
  return s;
}

export async function listViews(userId: string, path?: string): Promise<SavedView[]> {
  let q = db().from('user_saved_views').select('id, path, name, query, created_at').eq('user_id', userId);
  if (path) q = q.eq('path', path);
  const rows = mustMeta(await q.order('created_at', { ascending: false }).limit(MAX_VIEWS), 'Reading saved views') as ViewRow[];
  return rows.map(toView);
}

/** Saves (or replaces, by name on the same page) a view. */
export async function saveView(userId: string, input: { path?: unknown; name?: unknown; query?: unknown }): Promise<SavedView> {
  const path = checkPath(input.path);
  const name = typeof input.name === 'string' ? input.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
  if (!name || name.length > 80) throw new HttpError(400, 'Name the view (at most 80 characters)');
  const query = checkQuery(input.query);
  const { count, error } = await db().from('user_saved_views').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  mustMeta({ data: null, error }, 'Reading saved views');
  const existing = mustMeta(await db().from('user_saved_views').select('id').eq('user_id', userId).eq('path', path).eq('name', name).limit(1), 'Reading saved views') as { id: string }[];
  if (!existing.length && (count ?? 0) >= MAX_VIEWS) throw new HttpError(400, `At most ${MAX_VIEWS} saved views — delete one first`);
  const res = existing.length
    ? await db().from('user_saved_views').update({ query }).eq('id', existing[0].id).eq('user_id', userId).select('id, path, name, query, created_at')
    : await db().from('user_saved_views').insert({ user_id: userId, path, name, query }).select('id, path, name, query, created_at');
  const rows = mustMeta(res, 'Saving the view') as ViewRow[];
  return toView(rows[0]);
}

export async function deleteView(userId: string, id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'View not found');
  const rows = mustMeta(await db().from('user_saved_views').delete().eq('id', id).eq('user_id', userId).select('id'), 'Deleting the view') as unknown[];
  if (!rows.length) throw new HttpError(404, 'View not found');
}
