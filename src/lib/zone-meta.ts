import { compactNum } from '@/lib/num';
import 'server-only';
import { db } from './supabase';
import { HttpError } from './http';
import { listZones } from './zone-explorer';
import type { ZoneListItem } from './zone-catalog';
import { csvFile } from './zone-format';
import {
  CSV_HEADER, MAX_CONTACT, MAX_OWNER, MAX_TAGS, ZONE_ID, isFilterEmpty, notesText, oneLine, parseTags, readMetaCsv, searchTerm,
  type ZoneMeta, type ZoneMetaFilter, type ZoneMetaLite,
} from './zone-meta-types';

// Zone tags, owners, contacts and notes (supabase/migrations/0015_zone_meta.sql). Console data
// only — never sent to Cloudflare. Filters are resolved in the database (a GIN index on tags), so a
// page asks for "zones tagged env:prod" and gets the ids back in one round trip.

export type { ZoneMeta, ZoneMetaFilter, ZoneMetaLite } from './zone-meta-types';

export const META_NOT_SET_UP = 'Zone tags are not set up in the database yet: run supabase/migrations/0015_zone_meta.sql in the Supabase SQL editor, then reload this page';

/** Like supabase.must(), but a missing table or function (migration 0015 not applied) is a clear 503. */
export function mustMeta<T>(res: { data: T; error: { message: string; code?: string } | null }, what = 'Database request'): T {
  if (!res.error) return res.data;
  const { code, message } = res.error;
  if (code === '42P01' || code === '42883' || code === 'PGRST205' || code === 'PGRST202' || /does not exist|schema cache|could not find the function/i.test(message)) throw new HttpError(503, META_NOT_SET_UP);
  // A check constraint (too many tags, a value too long) is the caller's to fix.
  if (code === '23514') throw new HttpError(400, `Not saved: a value is too long or a zone has more than ${MAX_TAGS} tags`);
  throw new Error(`${what} failed: ${message}`);
}

interface MetaRow { zone_id: string; zone_name: string; account_name: string; tags: string[] | null; owner: string; contact: string; notes: string; updated_at: string | null; updated_by: string | null }
const COLUMNS = 'zone_id, zone_name, account_name, tags, owner, contact, notes, updated_at, updated_by';
const toMeta = (r: MetaRow): ZoneMeta => ({
  zoneId: r.zone_id, zoneName: r.zone_name, accountName: r.account_name, tags: r.tags ?? [], owner: r.owner, contact: r.contact, notes: r.notes,
  updatedAt: r.updated_at, updatedBy: r.updated_by,
});
const empty = (z: Pick<ZoneListItem, 'id' | 'name' | 'accountName'> | string): ZoneMeta => typeof z === 'string'
  ? { zoneId: z, zoneName: '', accountName: '', tags: [], owner: '', contact: '', notes: '' }
  : { zoneId: z.id, zoneName: z.name, accountName: z.accountName, tags: [], owner: '', contact: '', notes: '' };

const CHUNK = 100;

/** The full meta of these zones (at most a page or two of a list); zones without any are left out. */
export async function metaOf(zoneIds: string[]): Promise<Map<string, ZoneMeta>> {
  const ids = [...new Set(zoneIds.filter((id) => ZONE_ID.test(id)))];
  const out = new Map<string, ZoneMeta>();
  if (!ids.length) return out;
  if (ids.length > 400) {
    // Larger sets: everything in one call, then picked.
    const all = await allMeta(true);
    for (const id of ids) { const m = all.get(id); if (m) out.set(id, m); }
    return out;
  }
  const parts = await Promise.all(Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) =>
    db().from('zone_meta').select(COLUMNS).in('zone_id', ids.slice(i * CHUNK, i * CHUNK + CHUNK))));
  for (const p of parts) for (const r of mustMeta(p, 'Reading zone tags') as MetaRow[]) out.set(r.zone_id, toMeta(r));
  return out;
}

/** Tags and owner of every zone that has any (one call: an object keyed by zone id). `full` adds contact and notes. */
export async function allMeta(full = false): Promise<Map<string, ZoneMeta>> {
  const rows = mustMeta(await db().rpc('zone_meta_all', { p_full: full }), 'Reading zone tags') as { meta: Record<string, { t: string[]; o: string; c?: string; n?: string; zn?: string }> }[] | null;
  const obj = rows?.[0]?.meta ?? {};
  const out = new Map<string, ZoneMeta>();
  for (const [id, m] of Object.entries(obj)) out.set(id, { zoneId: id, zoneName: m.zn ?? '', accountName: '', tags: m.t ?? [], owner: m.o ?? '', contact: m.c ?? '', notes: m.n ?? '' });
  return out;
}

/** Compact form for lists: { zone id: { tags, owner } }. */
export const liteOf = (m: Map<string, ZoneMeta>): Record<string, ZoneMetaLite> =>
  Object.fromEntries([...m].filter(([, x]) => x.tags.length || x.owner).map(([id, x]) => [id, { tags: x.tags, owner: x.owner }]));

/** The zone ids a filter matches, or null when there is no filter (every zone). */
export async function zoneIdsMatching(filter: ZoneMetaFilter | null | undefined): Promise<Set<string> | null> {
  if (isFilterEmpty(filter)) return null;
  const tags = parseTags(filter!.tags ?? []).tags;
  const rows = mustMeta(await db().rpc('zone_meta_match', { p_tags: tags, p_owner: oneLine(filter!.owner, MAX_OWNER), p_q: searchTerm(filter!.q) }), 'Filtering zones by tag') as { zone_ids: string[] | null }[] | null;
  return new Set(rows?.[0]?.zone_ids ?? []);
}

/** Every tag with its zone count, most used first; and every owner. */
export async function tagsAndOwners(): Promise<{ tags: { tag: string; count: number }[]; owners: { owner: string; count: number }[] }> {
  const rows = mustMeta(await db().rpc('zone_meta_tags'), 'Reading tags') as { tags: { tag: string; count: number }[]; owners: { owner: string; count: number }[] }[] | null;
  return { tags: rows?.[0]?.tags ?? [], owners: rows?.[0]?.owners ?? [] };
}

export async function allTags(): Promise<{ tag: string; count: number }[]> {
  return (await tagsAndOwners()).tags;
}

/** A zone the stored tokens can read (names come from Cloudflare's list, not from the browser). */
export async function knownZone(zoneId: string): Promise<ZoneListItem> {
  if (!ZONE_ID.test(zoneId)) throw new HttpError(404, 'Zone not found');
  const z = (await listZones()).zones.find((x) => x.id === zoneId);
  if (!z) throw new HttpError(404, 'Zone not found — refresh the zone list if it was added recently');
  return z;
}

export interface MetaPatch { tags?: unknown; owner?: unknown; contact?: unknown; notes?: unknown }

/** Sets one zone's tags, owner, contact and notes (fields left out stay). Returns what was saved and what changed. */
export async function setMeta(zoneId: string, patch: MetaPatch, by: string): Promise<{ meta: ZoneMeta; changed: Record<string, unknown> }> {
  const zone = await knownZone(zoneId);
  const before = (await metaOf([zoneId])).get(zoneId) ?? empty(zone);
  const next: ZoneMeta = { ...before, zoneName: zone.name, accountName: zone.accountName };
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags) && typeof patch.tags !== 'string') throw new HttpError(400, 'Tags must be a list');
    const t = parseTags(patch.tags as string | string[]);
    if (t.bad.length) throw new HttpError(400, `Not a tag: ${t.bad.slice(0, 3).join(', ')} — use letters, digits and : . _ / - (like team:payments)`);
    if (t.tags.length > MAX_TAGS) throw new HttpError(400, `A zone has at most ${MAX_TAGS} tags`);
    next.tags = t.tags;
  }
  if (patch.owner !== undefined) next.owner = oneLine(patch.owner, MAX_OWNER);
  if (patch.contact !== undefined) next.contact = oneLine(patch.contact, MAX_CONTACT);
  if (patch.notes !== undefined) next.notes = notesText(patch.notes);
  const changed: Record<string, unknown> = {};
  if (next.tags.join() !== before.tags.join()) changed.tags = { from: before.tags, to: next.tags };
  for (const k of ['owner', 'contact'] as const) if (next[k] !== before[k]) changed[k] = { from: before[k], to: next[k] };
  if (next.notes !== before.notes) changed.notes = 'changed';
  if (!Object.keys(changed).length) return { meta: before, changed };
  if (!next.tags.length && !next.owner && !next.contact && !next.notes) {
    mustMeta(await db().from('zone_meta').delete().eq('zone_id', zoneId), 'Saving zone tags');
    return { meta: { ...next, updatedAt: new Date().toISOString(), updatedBy: by }, changed };
  }
  const rows = mustMeta(await db().from('zone_meta').upsert({
    zone_id: zoneId, zone_name: next.zoneName, account_name: next.accountName, tags: next.tags, owner: next.owner, contact: next.contact, notes: next.notes,
    updated_at: new Date().toISOString(), updated_by: by,
  }).select(COLUMNS), 'Saving zone tags') as MetaRow[];
  return { meta: rows[0] ? toMeta(rows[0]) : next, changed };
}

/** The zones a bulk change covers: these ids, or every zone a filter (and a name search) matches. */
export async function resolveZones(sel: { zoneIds?: unknown; filter?: ZoneMetaFilter; search?: unknown }): Promise<ZoneListItem[]> {
  const zones = (await listZones()).zones;
  if (Array.isArray(sel.zoneIds)) {
    const want = new Set(sel.zoneIds.filter((x): x is string => typeof x === 'string' && ZONE_ID.test(x)));
    return zones.filter((z) => want.has(z.id));
  }
  return searchZones(zones, sel.filter ?? {}, typeof sel.search === 'string' ? sel.search : '');
}

/** Zones whose name, account or id contains `search` and that match the tag filter (resolved in the database). */
export async function searchZones(zones: ZoneListItem[], filter: ZoneMetaFilter, search: string): Promise<ZoneListItem[]> {
  const ids = await zoneIdsMatching(filter);
  const s = search.trim().toLowerCase();
  return zones.filter((z) => (!ids || ids.has(z.id)) && (!s || z.name.toLowerCase().includes(s) || z.accountName.toLowerCase().includes(s) || z.id === s));
}

const MAX_BULK = 20_000;
const BULK_CHUNK = 2_000;

/** Adds and removes tags on many zones at once (and sets their owner when `owner` is a string). */
export async function bulkTag(zones: ZoneListItem[], add: unknown, remove: unknown, owner: unknown, by: string): Promise<{ zones: number; changed: number; add: string[]; remove: string[] }> {
  if (!zones.length) throw new HttpError(400, 'No zone matches — nothing to change');
  if (zones.length > MAX_BULK) throw new HttpError(400, `At most ${compactNum(MAX_BULK)} zones at once`);
  const a = parseTags(Array.isArray(add) || typeof add === 'string' ? add as string[] : []);
  const r = parseTags(Array.isArray(remove) || typeof remove === 'string' ? remove as string[] : []);
  if (a.bad.length || r.bad.length) throw new HttpError(400, `Not a tag: ${[...a.bad, ...r.bad].slice(0, 3).join(', ')}`);
  const o = typeof owner === 'string' ? oneLine(owner, MAX_OWNER) : null;
  if (!a.tags.length && !r.tags.length && o === null) throw new HttpError(400, 'Choose tags to add or remove, or an owner');
  let changed = 0;
  for (let i = 0; i < zones.length; i += BULK_CHUNK) {
    const part = zones.slice(i, i + BULK_CHUNK).map((z) => ({ id: z.id, name: z.name, account: z.accountName }));
    const rows = mustMeta(await db().rpc('zone_meta_bulk', { p_zones: part, p_add: a.tags, p_remove: r.tags, p_owner: o, p_by: by }), 'Tagging zones') as { changed: number }[] | null;
    changed += Number(rows?.[0]?.changed ?? 0);
  }
  return { zones: zones.length, changed, add: a.tags, remove: r.tags };
}

/** Renames a tag everywhere (merging into `to` when it exists); `to` empty removes the tag. */
export async function renameTag(from: unknown, to: unknown, by: string): Promise<{ from: string; to: string; changed: number }> {
  const f = parseTags(typeof from === 'string' ? [from] : []).tags[0];
  if (!f) throw new HttpError(400, 'Choose the tag to rename');
  const raw = typeof to === 'string' ? to.trim() : '';
  const t = raw ? parseTags([raw]).tags[0] : '';
  if (raw && !t) throw new HttpError(400, `“${raw.slice(0, 80)}” is not a tag — use letters, digits and : . _ / -`);
  if (t === f) throw new HttpError(400, 'The new name is the same');
  const rows = mustMeta(await db().rpc('zone_meta_rename_tag', { p_from: f, p_to: t, p_by: by }), 'Renaming the tag') as { changed: number }[] | null;
  return { from: f, to: t, changed: Number(rows?.[0]?.changed ?? 0) };
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** Every zone the tokens can read, with its tags and owner: a file to fill in and import again. */
export async function exportCsv(): Promise<string> {
  const [{ zones }, meta] = await Promise.all([listZones(), allMeta(true)]);
  const seen = new Set<string>();
  const rows: unknown[][] = [[...CSV_HEADER]];
  for (const z of zones) {
    seen.add(z.id);
    const m = meta.get(z.id);
    rows.push([z.id, z.name, z.accountName, (m?.tags ?? []).join(';'), m?.owner ?? '', m?.contact ?? '', m?.notes ?? '']);
  }
  // Tagged zones the tokens no longer list are kept in the file (not lost on a re-import).
  for (const [id, m] of meta) if (!seen.has(id)) rows.push([id, m.zoneName, '', m.tags.join(';'), m.owner, m.contact, m.notes]);
  return csvFile(rows);
}

export interface ImportResult { rows: number; matched: number; changed: number; unknown: string[]; unknownCount: number; errors: string[]; dryRun: boolean }

/**
 * Imports a CSV: each row names a zone (id, or name when the id is blank) and replaces the columns
 * the file has. Zones the tokens cannot read are reported and skipped. `dryRun` only checks.
 */
export async function importCsv(text: string, by: string, dryRun: boolean): Promise<ImportResult> {
  const parsed = readMetaCsv(text);
  const { zones } = await listZones();
  const byId = new Map(zones.map((z) => [z.id, z]));
  const byName = new Map<string, ZoneListItem[]>();
  for (const z of zones) byName.set(z.name.toLowerCase(), [...(byName.get(z.name.toLowerCase()) ?? []), z]);
  const errors = [...parsed.errors];
  const unknown: string[] = [];
  const picked = new Map<string, { zone: ZoneListItem; row: (typeof parsed.rows)[number] }>();
  for (const row of parsed.rows) {
    let zone = row.zoneId ? byId.get(row.zoneId) : undefined;
    if (!zone && !row.zoneId) {
      const named = byName.get(row.zoneName) ?? [];
      if (named.length > 1) { errors.push(`Line ${row.line}: ${row.zoneName} is in ${named.length} accounts — give its zone_id`); continue; }
      zone = named[0];
    }
    if (!zone) { unknown.push(row.zoneId || row.zoneName); continue; }
    if (picked.has(zone.id)) errors.push(`Line ${row.line}: ${zone.name} appears again — the last line wins`);
    picked.set(zone.id, { zone, row });
  }
  const current = picked.size ? await metaOf([...picked.keys()]) : new Map<string, ZoneMeta>();
  const upserts: Record<string, unknown>[] = [];
  const drops: string[] = [];
  const at = new Date().toISOString();
  for (const { zone, row } of picked.values()) {
    const before = current.get(zone.id) ?? empty(zone);
    const next = { tags: row.tags ?? before.tags, owner: row.owner ?? before.owner, contact: row.contact ?? before.contact, notes: row.notes ?? before.notes };
    if (next.tags.join() === before.tags.join() && next.owner === before.owner && next.contact === before.contact && next.notes === before.notes) continue;
    if (!next.tags.length && !next.owner && !next.contact && !next.notes) { drops.push(zone.id); continue; }
    upserts.push({ zone_id: zone.id, zone_name: zone.name, account_name: zone.accountName, ...next, updated_at: at, updated_by: by });
  }
  if (!dryRun) {
    for (let i = 0; i < upserts.length; i += 500) mustMeta(await db().from('zone_meta').upsert(upserts.slice(i, i + 500)), 'Importing zone tags');
    for (let i = 0; i < drops.length; i += CHUNK) mustMeta(await db().from('zone_meta').delete().in('zone_id', drops.slice(i, i + CHUNK)), 'Importing zone tags');
  }
  return { rows: parsed.rows.length, matched: picked.size, changed: upserts.length + drops.length, unknown: unknown.slice(0, 50), unknownCount: unknown.length, errors: errors.slice(0, 50), dryRun };
}
