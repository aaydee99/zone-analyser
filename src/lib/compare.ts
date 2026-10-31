import 'server-only';
import { db } from './supabase';
import { HttpError } from './http';
import { cached } from './cache';
import { mustSearch } from './zone-search';
import { readZoneBackup, zoneBackups, type BackupRef } from './backup-sources';
import {
  MAX_TEMPLATE_ITEMS, cleanItems, diffBackups, diffZones, evaluate, isIndexKind, templateFrom,
  type Gap, type IndexKind, type ItemDiff, type ResourceChange, type StoredRow, type TemplateItem,
} from './zone-index';

// Comparisons, read-only (nothing is applied): two backups of one zone (from the .tf files), two
// zones (their newest backups and snapshots, from the search index), and zones against a template —
// a named baseline kept in Supabase (0016_zone_search.sql). Template results are computed from the
// index in the background and kept until the template or the index changes.

export const ZONE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const page = <T,>(list: T[], offset: number, limit: number) => list.slice(offset, offset + limit);
const bounds = (o: { offset?: number; limit?: number }) => ({ offset: Math.max(0, Math.floor(o.offset ?? 0)), limit: Math.min(200, Math.max(1, Math.floor(o.limit ?? 50))) });

// ── Zones ───────────────────────────────────────────────────────────────────

export interface IndexedZone { zoneId: string; zoneName: string; accountId: string | null; sources: { source: string; at: string }[] }

/** Zones the index holds, by name (for pickers): at most `limit`. */
export async function indexedZones(q: string, limit = 50): Promise<IndexedZone[]> {
  let query = db().from('zone_search_sources').select('zone_id, zone_name, account_id, source, source_at');
  const term = q.toLowerCase().replace(/[%_*,()\\]/g, ' ').trim().slice(0, 100);
  if (term) query = query.ilike('zone_name', `%${term}%`);
  const rows = mustSearch(await query.order('zone_name').limit(Math.min(200, limit) * 6), 'Reading zones') as { zone_id: string; zone_name: string; account_id: string | null; source: string; source_at: string }[];
  const out = new Map<string, IndexedZone>();
  for (const r of rows) {
    const z = out.get(r.zone_id) ?? { zoneId: r.zone_id, zoneName: r.zone_name, accountId: r.account_id, sources: [] };
    z.accountId ??= r.account_id;
    z.sources.push({ source: r.source, at: r.source_at });
    out.set(r.zone_id, z);
  }
  return [...out.values()].slice(0, limit);
}

export async function zoneInfo(zoneId: string): Promise<IndexedZone & { accountName: string | null }> {
  if (!ZONE_ID.test(zoneId)) throw new HttpError(400, 'Unknown zone');
  const rows = mustSearch(await db().from('zone_search_sources').select('zone_id, zone_name, account_id, source, source_at').eq('zone_id', zoneId), 'Reading the zone') as { zone_id: string; zone_name: string; account_id: string | null; source: string; source_at: string }[];
  const t = (await db().from('monitor_targets').select('zone_name, account_id, account_name').eq('scope_kind', 'zone').eq('scope_id', zoneId).limit(1)).data?.[0] as { zone_name: string | null; account_id: string | null; account_name: string | null } | undefined;
  const name = rows[0]?.zone_name ?? t?.zone_name;
  if (!name) throw new HttpError(404, 'That zone has no stored data yet (no indexed backup or monitoring result) — rebuild the search index, or wait for the next backup');
  return { zoneId, zoneName: name, accountId: rows.find((r) => r.account_id)?.account_id ?? t?.account_id ?? null, accountName: t?.account_name ?? null, sources: rows.map((r) => ({ source: r.source, at: r.source_at })) };
}

/** Every stored row of some zones (and only some items, when given). */
async function rowsOf(zoneIds: string[], items: string[] | null = null): Promise<Map<string, StoredRow[]>> {
  const out = new Map<string, StoredRow[]>();
  if (!zoneIds.length) return out;
  const rows = mustSearch(await db().rpc('zone_search_items', { p_zones: zoneIds, p_items: items }), 'Reading stored configuration') as { zone_id: string; kind: IndexKind; item: string; path: string; value: string; source: string; source_at: string }[] | null;
  for (const r of rows ?? []) {
    const list = out.get(r.zone_id) ?? [];
    list.push({ kind: r.kind, item: r.item, path: r.path, subject: '', value: r.value, source: r.source, sourceAt: new Date(r.source_at).toISOString() });
    out.set(r.zone_id, list);
  }
  return out;
}

// ── Backup vs backup ────────────────────────────────────────────────────────

/** The backups that hold a zone (this server's folders and the approved buckets), newest first. */
export async function backupsOf(zoneId: string): Promise<{ zone: { id: string; name: string }; backups: BackupRef[]; problems: string[] }> {
  const z = await zoneInfo(zoneId);
  const r = await cached(`compare:backups:${zoneId}`, 5 * 60_000, () => zoneBackups(z.zoneName, z.accountName));
  return { zone: { id: zoneId, name: z.zoneName }, ...r };
}

export interface BackupDiffPage { zone: { id: string; name: string }; a: BackupRef; b: BackupRef; changes: ResourceChange[]; types: string[]; total: number; counts: { added: number; removed: number; changed: number; unchanged: number }; offset: number; limit: number }

/** What changed from backup `a` to backup `b` of one zone, resource by resource (a page of changes). */
export async function compareBackups(zoneId: string, a: string, b: string, o: { offset?: number; limit?: number; type?: string } = {}): Promise<BackupDiffPage> {
  if (a === b) throw new HttpError(400, 'Choose two different backups');
  const z = await zoneInfo(zoneId);
  const full = await cached(`compare:backup-diff:${zoneId}:${a}:${b}`, 10 * 60_000, async () => {
    const [x, y] = await Promise.all([readZoneBackup(a, z.zoneName), readZoneBackup(b, z.zoneName)]);
    return { a: x.ref, b: y.ref, ...diffBackups(x.files, y.files) };
  });
  const list = o.type ? full.changes.filter((c) => c.type === o.type) : full.changes;
  const { offset, limit } = bounds(o);
  const count = (k: ResourceChange['change']) => full.changes.filter((c) => c.change === k).length;
  return { zone: { id: zoneId, name: z.zoneName }, a: full.a, b: full.b, changes: page(list, offset, limit), types: [...new Set(full.changes.map((c) => c.type))].sort(), total: list.length, counts: { added: count('added'), removed: count('removed'), changed: count('changed'), unchanged: full.unchanged }, offset, limit };
}

// ── Zone vs zone ────────────────────────────────────────────────────────────

export interface ZoneDiffPage { a: { id: string; name: string }; b: { id: string; name: string }; diffs: ItemDiff[]; total: number; same: number; counts: { onlyA: number; onlyB: number; different: number }; offset: number; limit: number }

/** Two zones' stored configuration side by side (their names written as {zone} in values). */
export async function compareZones(aId: string, bId: string, o: { offset?: number; limit?: number; kind?: string; status?: string } = {}): Promise<ZoneDiffPage> {
  if (aId === bId) throw new HttpError(400, 'Choose two different zones');
  const [za, zb] = await Promise.all([zoneInfo(aId), zoneInfo(bId)]);
  const full = await cached(`compare:zones:${aId}:${bId}`, 2 * 60_000, async () => {
    const rows = await rowsOf([aId, bId]);
    return diffZones(rows.get(aId) ?? [], za.zoneName, rows.get(bId) ?? [], zb.zoneName);
  });
  let list = full.diffs;
  if (o.kind && isIndexKind(o.kind)) list = list.filter((d) => d.kind === o.kind);
  if (o.status === 'only-a' || o.status === 'only-b' || o.status === 'different') list = list.filter((d) => d.status === o.status);
  const { offset, limit } = bounds(o);
  const n = (s: ItemDiff['status']) => full.diffs.filter((d) => d.status === s).length;
  return { a: { id: aId, name: za.zoneName }, b: { id: bId, name: zb.zoneName }, diffs: page(list, offset, limit), total: list.length, same: full.same, counts: { onlyA: n('only-a'), onlyB: n('only-b'), different: n('different') }, offset, limit };
}

// ── Templates ───────────────────────────────────────────────────────────────

export interface Template { id: string; name: string; description: string; sourceZoneId: string | null; sourceZoneName: string | null; items: TemplateItem[]; createdBy: string | null; createdAt: string; updatedBy: string | null; updatedAt: string }
interface TemplateRow { id: string; name: string; description: string; source_zone_id: string | null; source_zone_name: string | null; items: TemplateItem[]; created_by: string | null; created_at: string; updated_by: string | null; updated_at: string }
const toTemplate = (r: TemplateRow): Template => ({ id: r.id, name: r.name, description: r.description, sourceZoneId: r.source_zone_id, sourceZoneName: r.source_zone_name, items: cleanItems(r.items), createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at });
const TEMPLATE_ID = /^[0-9a-f-]{36}$/;

export async function listTemplates(): Promise<(Omit<Template, 'items'> & { itemCount: number })[]> {
  const rows = mustSearch(await db().from('zone_templates').select('*').order('name').limit(200), 'Reading templates') as TemplateRow[];
  return rows.map((r) => { const { items, ...t } = toTemplate(r); return { ...t, itemCount: items.length }; });
}

export async function getTemplate(id: string): Promise<Template> {
  if (!TEMPLATE_ID.test(id)) throw new HttpError(404, 'Unknown template');
  const r = mustSearch(await db().from('zone_templates').select('*').eq('id', id).maybeSingle(), 'Reading the template') as TemplateRow | null;
  if (!r) throw new HttpError(404, 'Unknown template');
  return toTemplate(r);
}

const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 100) : '');
const duplicate = (e: { code?: string } | null) => e?.code === '23505';

/** A new template from a zone's stored configuration: the kinds chosen (all when none) and items starting with `prefixes`. */
export async function createTemplate(by: string, input: { name?: unknown; description?: unknown; zoneId?: unknown; kinds?: unknown; prefixes?: unknown; items?: unknown }): Promise<Template> {
  const name = cleanName(input.name);
  if (!name) throw new HttpError(400, 'Give the template a name');
  let items: TemplateItem[] = cleanItems(input.items);
  let zone: { id: string; name: string } | null = null;
  if (typeof input.zoneId === 'string' && input.zoneId) {
    const z = await zoneInfo(input.zoneId);
    zone = { id: z.zoneId, name: z.zoneName };
    const kinds = Array.isArray(input.kinds) ? input.kinds.filter(isIndexKind) : [];
    const prefixes = Array.isArray(input.prefixes) ? input.prefixes.filter((p): p is string => typeof p === 'string' && !!p.trim()).map((p) => p.trim()).slice(0, 50) : [];
    items = templateFrom((await rowsOf([z.zoneId])).get(z.zoneId) ?? [], z.zoneName, kinds, prefixes);
    if (!items.length) throw new HttpError(400, `${z.zoneName} has nothing of the kinds chosen in the index`);
  }
  if (!items.length) throw new HttpError(400, 'Choose a zone to start from, or add items');
  const res = await db().from('zone_templates').insert({
    name, description: typeof input.description === 'string' ? input.description.slice(0, 1000) : '', source_zone_id: zone?.id ?? null, source_zone_name: zone?.name ?? null,
    items, created_by: by, updated_by: by,
  }).select('*').single();
  if (duplicate(res.error)) throw new HttpError(409, `A template named “${name}” already exists`);
  return toTemplate(mustSearch(res, 'Saving the template') as TemplateRow);
}

/** Changes a template's name, description or items (its kept results are computed again). */
export async function updateTemplate(id: string, by: string, input: { name?: unknown; description?: unknown; items?: unknown }): Promise<{ template: Template; changed: string[] }> {
  const before = await getTemplate(id);
  const set: Record<string, unknown> = { updated_by: by, updated_at: new Date().toISOString() };
  const changed: string[] = [];
  if (input.name !== undefined) { const n = cleanName(input.name); if (!n) throw new HttpError(400, 'Give the template a name'); if (n !== before.name) { set.name = n; changed.push('name'); } }
  if (typeof input.description === 'string' && input.description.slice(0, 1000) !== before.description) { set.description = input.description.slice(0, 1000); changed.push('description'); }
  if (input.items !== undefined) {
    if (Array.isArray(input.items) && input.items.length > MAX_TEMPLATE_ITEMS) throw new HttpError(400, `A template holds at most ${MAX_TEMPLATE_ITEMS} items`);
    const items = cleanItems(input.items);
    if (!items.length) throw new HttpError(400, 'A template needs at least one item');
    if (JSON.stringify(items) !== JSON.stringify(before.items)) { set.items = items; changed.push('items'); }
  }
  if (!changed.length) return { template: before, changed };
  const res = await db().from('zone_templates').update(set).eq('id', id).select('*').single();
  if (duplicate(res.error)) throw new HttpError(409, `A template named “${String(set.name)}” already exists`);
  const template = toTemplate(mustSearch(res, 'Saving the template') as TemplateRow);
  if (changed.includes('items')) mustSearch(await db().from('zone_template_results').delete().eq('template_id', id), 'Clearing template results');
  return { template, changed };
}

export async function deleteTemplate(id: string): Promise<Template> {
  const t = await getTemplate(id);
  mustSearch(await db().from('zone_templates').delete().eq('id', id), 'Deleting the template');
  return t;
}

/** One zone against a template, computed now. */
export async function templateZone(id: string, zoneId: string): Promise<{ template: { id: string; name: string }; zone: { id: string; name: string }; gaps: Gap[]; checked: number }> {
  const t = await getTemplate(id);
  const z = await zoneInfo(zoneId);
  const rows = (await rowsOf([zoneId], t.items.map((i) => i.item))).get(zoneId) ?? [];
  return { template: { id: t.id, name: t.name }, zone: { id: zoneId, name: z.zoneName }, gaps: evaluate(t.items, rows, z.zoneName), checked: t.items.length };
}

// Template results across every zone, computed in the background on this server.
interface Compute { startedAt: string; done: number; total: number; finishedAt?: string; error?: string }
const g = globalThis as unknown as { __templateCompute?: Map<string, Compute> };
const computing = () => (g.__templateCompute ??= new Map());

/** Computes (again) a template's gaps for every indexed zone, in the background. Returns the job. */
export function computeTemplate(id: string): Compute {
  const jobs = computing();
  const running = jobs.get(id);
  if (running && !running.finishedAt) return running;
  const job: Compute = { startedAt: new Date().toISOString(), done: 0, total: 0 };
  jobs.set(id, job);
  void (async () => {
    const t = await getTemplate(id);
    const items = t.items.map((i) => i.item);
    const zones: { zone_id: string; zone_name: string; account_id: string | null }[] = [];
    const seen = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const pageRows = mustSearch(await db().from('zone_search_sources').select('zone_id, zone_name, account_id').order('zone_id').range(from, from + 999), 'Reading zones') as { zone_id: string; zone_name: string; account_id: string | null }[];
      for (const z of pageRows) if (!seen.has(z.zone_id)) { seen.add(z.zone_id); zones.push(z); }
      if (pageRows.length < 1000) break;
    }
    job.total = zones.length;
    const at = new Date().toISOString();
    for (let i = 0; i < zones.length; i += 200) {
      const batch = zones.slice(i, i + 200);
      const rows = await rowsOf(batch.map((z) => z.zone_id), items);
      const out = batch.map((z) => {
        const gaps = evaluate(t.items, rows.get(z.zone_id) ?? [], z.zone_name);
        return { template_id: id, zone_id: z.zone_id, zone_name: z.zone_name, account_id: z.account_id, gaps: gaps.length, checked: t.items.length, details: gaps.slice(0, 100), computed_at: at };
      });
      mustSearch(await db().from('zone_template_results').upsert(out), 'Saving template results');
      job.done += batch.length;
    }
    // Zones no longer in the index.
    mustSearch(await db().from('zone_template_results').delete().eq('template_id', id).lt('computed_at', at), 'Saving template results');
  })().catch((err) => { job.error = err instanceof Error ? err.message : String(err); console.error(`[compare] template ${id}: ${job.error}`); })
    .finally(() => { job.finishedAt = new Date().toISOString(); });
  return job;
}

export interface GapRow { zoneId: string; zoneName: string; accountId: string | null; gaps: number; checked: number; details: Gap[]; computedAt: string }
export interface GapsPage {
  template: Omit<Template, 'items'> & { itemCount: number };
  zones: GapRow[]; total: number; offset: number; limit: number;
  summary: { zones: number; withGaps: number; computedAt: string | null; stale: boolean };
  computing: Compute | null;
}

/**
 * A page of a template's gaps per zone, most gaps first, from the kept results (filters: an account,
 * zone ids — a tag — and `onlyGaps`). Results older than the template or the index are computed
 * again in the background (the page says so); nothing kept yet starts that too.
 */
export async function templateGaps(id: string, o: { offset?: number; limit?: number; accountId?: string; zoneIds?: string[] | null; onlyGaps?: boolean } = {}): Promise<GapsPage> {
  const t = await getTemplate(id);
  const { offset, limit } = bounds(o);
  const COLS = 'zone_id, zone_name, account_id, gaps, checked, details, computed_at';
  type R = { zone_id: string; zone_name: string; account_id: string | null; gaps: number; checked: number; details: Gap[]; computed_at: string };
  const toRow = (r: R): GapRow => ({ zoneId: r.zone_id, zoneName: r.zone_name, accountId: r.account_id, gaps: r.gaps, checked: r.checked, details: r.details ?? [], computedAt: r.computed_at });
  let zones: GapRow[];
  let total: number;
  if (o.zoneIds) {
    // A tag can name thousands of zones: filtered here from the (small) result rows, details for the page only.
    const wanted = new Set(o.zoneIds);
    const all: R[] = [];
    for (let from = 0; ; from += 1000) {
      let q = db().from('zone_template_results').select('zone_id, zone_name, account_id, gaps, checked, computed_at').eq('template_id', id);
      if (o.accountId) q = q.eq('account_id', o.accountId);
      if (o.onlyGaps) q = q.gt('gaps', 0);
      const part = mustSearch(await q.order('gaps', { ascending: false }).order('zone_name').range(from, from + 999), 'Reading template results') as R[];
      all.push(...part.filter((r) => wanted.has(r.zone_id)));
      if (part.length < 1000) break;
    }
    total = all.length;
    const ids = page(all, offset, limit).map((r) => r.zone_id);
    const details = ids.length ? mustSearch(await db().from('zone_template_results').select(COLS).eq('template_id', id).in('zone_id', ids), 'Reading template results') as R[] : [];
    const byId = new Map(details.map((r) => [r.zone_id, r]));
    zones = ids.map((z) => toRow(byId.get(z)!)).filter((r) => r.zoneId);
  } else {
    let q = db().from('zone_template_results').select(COLS, { count: 'exact' }).eq('template_id', id);
    if (o.accountId) q = q.eq('account_id', o.accountId);
    if (o.onlyGaps) q = q.gt('gaps', 0);
    const res = await q.order('gaps', { ascending: false }).order('zone_name').range(offset, offset + limit - 1);
    zones = (mustSearch(res, 'Reading template results') as R[]).map(toRow);
    total = res.count ?? zones.length;
  }
  const head = async (gaps: boolean) => {
    let q = db().from('zone_template_results').select('zone_id', { count: 'exact', head: true }).eq('template_id', id);
    if (gaps) q = q.gt('gaps', 0);
    const r = await q;
    mustSearch(r, 'Counting template results');
    return r.count ?? 0;
  };
  const [count, withGaps, oldest, indexed] = await Promise.all([
    head(false), head(true),
    db().from('zone_template_results').select('computed_at').eq('template_id', id).order('computed_at').limit(1),
    db().from('zone_search_sources').select('indexed_at').order('indexed_at', { ascending: false }).limit(1),
  ]);
  const computedAt = (oldest.data?.[0] as { computed_at: string } | undefined)?.computed_at ?? null;
  const lastIndexed = (indexed.data?.[0] as { indexed_at: string } | undefined)?.indexed_at ?? null;
  const stale = !computedAt || computedAt < t.updatedAt || (!!lastIndexed && computedAt < lastIndexed);
  let job = computing().get(id) ?? null;
  // Recomputed at most every 10 minutes on its own (a busy index changes all the time).
  if (stale && (!job || (job.finishedAt && Date.parse(job.finishedAt) < Date.now() - 10 * 60_000)) && (!computedAt || !lastIndexed || computedAt < t.updatedAt || Date.parse(computedAt) < Date.now() - 10 * 60_000)) job = computeTemplate(id);
  const { items, ...meta } = t;
  return { template: { ...meta, itemCount: items.length }, zones, total, offset, limit, summary: { zones: count, withGaps, computedAt, stale }, computing: job && !job.finishedAt ? job : job?.error ? job : null };
}
