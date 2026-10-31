import 'server-only';
import path from 'node:path';
import { db } from './supabase';
import { HttpError } from './http';
import { stripAnsi, type RunMeta } from './run-types';
import { parseBackupFolder } from './restore-hcl';
import { bucketFolders, bucketStores, localFolders, localZones, readBucketZone, readLocalZone, zoneFolder, type Store } from './backup-sources';
import { listObjects } from './bucket-store';
import {
  INDEXED_CHECKS, backupRows, backupZone, ipQuery, isIndexKind, monitorRows, rowIp, snapshotRows,
  type IndexKind, type IndexRow, type SnapshotLike,
} from './zone-index';

// Search across every zone ("where is this used?"): an index in Supabase (0016_zone_search.sql) of
// what the console already stores — each zone's newest backup (.tf files), its drift snapshot and the
// monitoring results worth finding (Page Rules, certificates, scripts …). It is filled as those are
// saved (monitoring units, finished backups) and rebuilt on request; searching never calls Cloudflare.

export const SEARCH_NOT_SET_UP = 'Zone search is not set up in the database yet: run supabase/migrations/0016_zone_search.sql in the Supabase SQL editor, then reload this page';

/** Like supabase.must(), but a missing table or function (0016 not applied) is a clear 503. */
export function mustSearch<T>(res: { data: T; error: { message: string; code?: string } | null }, what = 'Database request'): T {
  if (!res.error) return res.data;
  const { code, message } = res.error;
  if (code === '42P01' || code === '42883' || code === 'PGRST205' || code === 'PGRST202' || /does not exist|schema cache|Could not find the function/i.test(message)) throw new HttpError(503, SEARCH_NOT_SET_UP);
  throw new Error(`${what} failed: ${message}`);
}

const log = (m: string) => console.log(`[zone-search] ${m}`);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const notSetUp = (e: unknown) => e instanceof HttpError && e.status === 503;

// ── Searching ───────────────────────────────────────────────────────────────

export type SearchMode = 'exact' | 'contains';
export interface SearchOptions {
  mode?: SearchMode;
  kinds?: IndexKind[];
  accountId?: string;
  /** Only these zones. */
  zoneIds?: string[];
  /** Only zones with every one of these tags (zone tags, 0015_zone_meta). */
  tags?: string[];
  owner?: string;
  offset?: number;
  limit?: number;
}
export interface SearchHit {
  zoneId: string;
  zoneName: string;
  accountId: string | null;
  kind: IndexKind;
  /** Where in the zone: "DNS A www.example.com", "Ruleset http_request_firewall_custom rule 3 expression". */
  where: string;
  subject: string;
  /** The value around the match: before, the match, after (cut to about 160 characters). */
  snippet: { before: string; match: string; after: string };
  source: string;
  sourceLabel: string;
  sourceRef: string | null;
  sourceAt: string;
}
export interface SearchResult { q: string; mode: SearchMode; hits: SearchHit[]; total: number; capped: boolean; offset: number; limit: number; note?: string }

export const MIN_CONTAINS = 3;
const MAX_TOTAL = 5000;

export const sourceLabel = (source: string, ref?: string | null) =>
  source === 'backup' ? `backup${ref ? ` ${ref.replace(/^(local|bucket:[^:]+:[^:]+:[^:]+):/, '')}` : ''}` : source === 'drift' ? 'drift snapshot' : source.startsWith('monitor:') ? `monitoring (${source.slice(8)})` : source;

function snippet(value: string, q: string): SearchHit['snippet'] {
  const v = value.replace(/\s+/g, ' ');
  const i = v.toLowerCase().indexOf(q);
  if (i < 0) return { before: '', match: '', after: v.length > 160 ? `${v.slice(0, 160)}…` : v };
  const from = Math.max(0, i - 60);
  const end = Math.min(v.length, i + q.length + 80);
  return { before: `${from ? '…' : ''}${v.slice(from, i)}`, match: v.slice(i, i + q.length), after: `${v.slice(i + q.length, end)}${end < v.length ? '…' : ''}` };
}

/** Zones a tag / owner filter matches (zone tags, src/lib/zone-meta.ts); null when there is none. */
async function zonesTagged(tags: string[] | undefined, owner: string | undefined): Promise<Set<string> | null> {
  if (!tags?.length && !owner) return null;
  const meta = await import('./zone-meta');
  return meta.zoneIdsMatching({ tags: tags ?? [], owner: owner ?? '' });
}

/**
 * Searches every zone's stored configuration. `exact` matches a whole value (or what it belongs to,
 * like a record name or a header name), `contains` any part of it (3 characters or more). An IP
 * address or a CIDR range also finds every address in it. Sorted by zone; at most 5,000 counted.
 */
export async function searchZones(q: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const term = q.trim().replace(/\s+/g, ' ').slice(0, 200);
  let mode: SearchMode = opts.mode === 'exact' ? 'exact' : 'contains';
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const empty = (note?: string): SearchResult => ({ q: term, mode, hits: [], total: 0, capped: false, offset, limit, ...(note ? { note } : {}) });
  if (!term) return empty();
  let note: string | undefined;
  if (mode === 'contains' && term.length < MIN_CONTAINS && !ipQuery(term)) { mode = 'exact'; note = `Searches shorter than ${MIN_CONTAINS} characters match whole values only`; }
  let zones = opts.zoneIds?.length ? [...new Set(opts.zoneIds)] : null;
  const tagged = await zonesTagged(opts.tags, opts.owner);
  if (tagged) zones = zones ? zones.filter((z) => tagged.has(z)) : [...tagged];
  if (zones && !zones.length) return empty(tagged ? 'No zone has these tags' : undefined);
  const kinds = opts.kinds?.filter(isIndexKind);
  type Found = { zone_id: string; zone_name: string; account_id: string | null; kind: IndexKind; path: string; subject: string; value: string; source: string; source_ref: string | null; source_at: string; total: number | string };
  const find = async (from: number, n: number) => (mustSearch(await db().rpc('zone_search_find', {
    p_q: term, p_mode: mode, p_kinds: kinds?.length ? kinds : null, p_account: opts.accountId || null, p_zones: zones, p_offset: from, p_limit: n,
  }), 'Searching zones') as Found[] | null) ?? [];
  const list = await find(offset, limit);
  // A page past the end: the count comes from the first row.
  const total = list.length ? Number(list[0].total) : offset ? Number((await find(0, 1))[0]?.total ?? 0) : 0;
  const needle = term.toLowerCase();
  return {
    q: term, mode, offset, limit, ...(note ? { note } : {}),
    total: Math.min(total, MAX_TOTAL), capped: total > MAX_TOTAL,
    hits: list.map((r) => ({
      zoneId: r.zone_id, zoneName: r.zone_name, accountId: r.account_id, kind: r.kind, where: r.path, subject: r.subject,
      snippet: snippet(r.value, needle), source: r.source, sourceLabel: sourceLabel(r.source, r.source_ref), sourceRef: r.source_ref, sourceAt: r.source_at,
    })),
  };
}

export interface IndexSource { source: string; label: string; zones: number; rows: number; newest: string | null; oldest: string | null }
export interface IndexStatus { sources: IndexSource[]; zones: number; rebuild: RebuildState | null; generatedAt: string }

/** What the index holds, and the rebuild running (or last run) on this server. */
export async function indexStatus(): Promise<IndexStatus> {
  const rows = mustSearch(await db().rpc('zone_search_status'), 'Reading the search index') as { source: string; zones: number; rows: number; newest: string | null; oldest: string | null }[] | null;
  const res = await db().from('zone_search_sources').select('zone_id', { count: 'exact', head: true }).eq('source', 'backup');
  mustSearch(res, 'Reading the search index');
  const sources = (rows ?? []).map((r) => ({ source: r.source, label: sourceLabel(r.source), zones: Number(r.zones), rows: Number(r.rows), newest: r.newest, oldest: r.oldest }));
  return { sources, zones: Math.max(0, ...sources.map((s) => s.zones)), rebuild: state().rebuild, generatedAt: new Date().toISOString() };
}

// ── Writing ─────────────────────────────────────────────────────────────────

export interface ZoneRef { zoneId: string; zoneName: string; accountId: string | null }
const CHUNK = 2000;

/** Replaces what one source holds of a zone. An older copy than the one indexed is left out (returns -1). */
export async function indexZone(z: ZoneRef, source: string, ref: string | null, at: string, rows: IndexRow[]): Promise<number> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(z.zoneId)) return 0;
  const out = rows.map((r) => ({ ...r, ip: (r.kind === 'dns' || r.kind === 'resource') ? rowIp(r) : null }));
  let n = 0;
  for (let i = 0; i === 0 || i < out.length; i += CHUNK) {
    const res = mustSearch(await db().rpc('zone_search_replace', {
      p_zone: z.zoneId, p_zone_name: z.zoneName, p_account: z.accountId, p_source: source, p_ref: ref, p_at: at, p_rows: out.slice(i, i + CHUNK), p_replace: i === 0,
    }), 'Saving the search index') as { kept: number }[] | null;
    n = Number(res?.[0]?.kept ?? 0);
    if (n < 0) return n;
  }
  return n;
}

// A small queue on each server: index writes after a monitoring unit or a backup run happen here, in
// the background, two at a time, so they never slow down the work that triggered them. A key queued
// again before it ran is replaced (only the newest result counts).
interface Q { pending: Map<string, () => Promise<void>>; running: number; warned: boolean; rebuild: RebuildState | null }
const g = globalThis as unknown as { __zoneSearch?: Q };
const state = () => (g.__zoneSearch ??= { pending: new Map(), running: 0, warned: false, rebuild: null });
const MAX_PENDING = 5000;

function enqueue(key: string, task: () => Promise<void>) {
  const s = state();
  s.pending.delete(key);
  if (s.pending.size >= MAX_PENDING) s.pending.delete(s.pending.keys().next().value!);
  s.pending.set(key, task);
  pump();
}
function pump() {
  const s = state();
  while (s.running < 2 && s.pending.size) {
    const [key, task]: [string, () => Promise<void>] = s.pending.entries().next().value!;
    s.pending.delete(key);
    s.running++;
    void task().catch((err: unknown) => {
      if (notSetUp(err)) { if (!s.warned) { s.warned = true; log('not indexing: 0016_zone_search.sql is not applied'); } return; }
      log(`${key}: ${message(err)}`);
    }).finally(() => { s.running--; setImmediate(pump); });
  }
}

/**
 * Called after a monitoring unit's result is saved (monitor-store saveResult). Cheap: only queues
 * the work. Zone units of the checks worth finding are indexed; drift indexes the zone's snapshot.
 */
export function indexMonitorUnit(k: { check: string; kind: string; id: string }, sections: Partial<Record<string, Record<string, unknown>[]>>) {
  if (k.kind !== 'zone' || !INDEXED_CHECKS.has(k.check)) return;
  enqueue(`monitor:${k.check}:${k.id}`, async () => {
    if (k.check === 'drift') {
      const snap = mustSearch(await db().from('monitor_snapshots').select('data, taken_at').eq('zone_id', k.id).eq('kind', 'latest').maybeSingle(), 'Reading the drift snapshot') as { data: SnapshotLike & { zoneName?: string; accountId?: string }; taken_at: string } | null;
      if (!snap?.data?.zoneName) return;
      await indexZone({ zoneId: k.id, zoneName: snap.data.zoneName, accountId: snap.data.accountId || null }, 'drift', null, snap.taken_at, snapshotRows(snap.data, snap.data.zoneName));
      return;
    }
    const t = mustSearch(await db().from('monitor_targets').select('zone_name, account_id').eq('check_id', k.check).eq('scope_kind', 'zone').eq('scope_id', k.id).maybeSingle(), 'Reading the zone') as { zone_name: string | null; account_id: string | null } | null;
    if (!t?.zone_name) return;
    await indexZone({ zoneId: k.id, zoneName: t.zone_name, accountId: t.account_id }, `monitor:${k.check}`, null, new Date().toISOString(), monitorRows(k.check, sections, t.zone_name));
  });
}

/** Indexes one zone's backup files; null when they do not name their zone. */
async function indexBackupFiles(zoneName: string, files: { name: string; text: string }[], ref: string, at: string): Promise<number | null> {
  const { zoneId, accountId } = backupZone(files);
  if (!zoneId) return null;
  return indexZone({ zoneId, zoneName, accountId }, 'backup', ref, at, backupRows(files, zoneName));
}

/** The backup folders a run wrote ("[INFO] Output : <folder>", once per account). */
export function runFolders(lines: string[]): string[] {
  const out = new Set<string>();
  for (const l of lines) {
    const m = /^\[INFO\]\s+Output\s+:\s+(.+)$/.exec(stripAnsi(l));
    if (m) out.add(path.basename(m[1].trim()));
  }
  return [...out].filter((f) => !!parseBackupFolder(f).time);
}

/**
 * Called when a backup run ends (runner.ts): its zones are indexed in the background, from this
 * server's copy of the folders, or from a bucket when the run kept no local copy.
 */
export function indexBackupRun(meta: Pick<RunMeta, 'id' | 'status' | 'summary'>, lines: string[]) {
  if (meta.status !== 'succeeded' && meta.status !== 'failed') return;
  const folders = runFolders(meta.summary.backupRoot ? [...lines, `[INFO] Output : ${meta.summary.backupRoot}`] : lines);
  if (!folders.length) return;
  enqueue(`run:${meta.id}`, async () => {
    let stores: Store[] | null = null;
    for (const folder of folders) {
      const at = parseBackupFolder(folder).time!;
      const zones = localZones(folder);
      if (zones.length) {
        for (const z of zones) {
          const files = readLocalZone(folder, z);
          if (files?.length) await indexBackupFiles(z, files, `local:${folder}`, at);
        }
        continue;
      }
      stores ??= await bucketStores().catch(() => []);
      for (const s of stores) {
        if (await indexBucketFolder(s, folder, at, new Set()).catch(() => 0)) break;
      }
    }
  });
}

/** Indexes the zones of one bucket folder not in `skip`; returns how many were indexed. */
async function indexBucketFolder(s: Store, folder: string, at: string, skip: Set<string>, progress?: RebuildState, signal?: AbortSignal): Promise<number> {
  // One listing of the whole folder (1,000 keys a page) instead of one per zone.
  const base = `${s.target.prefix}${folder}/`;
  await pace();
  const { keys } = await listObjects(s.target, base);
  const byZone = new Map<string, string[]>();
  for (const k of keys) {
    const rest = k.key.slice(base.length).split('/');
    if (rest.length !== 2 || !rest[1].endsWith('.tf') || rest[0] === 'account' || rest[0].startsWith('_')) continue;
    byZone.set(rest[0], [...(byZone.get(rest[0]) ?? []), k.key]);
  }
  let n = 0;
  for (const [z, list] of byZone) {
    if (signal?.aborted) break;
    if (skip.has(z.toLowerCase())) continue;
    await pace(list.length);
    const files = await readBucketZone(s.target, folder, z, list).catch(() => null);
    if (!files?.length) continue;
    const r = await indexBackupFiles(z, files, `bucket:${s.id}:${folder}`, at);
    skip.add(z.toLowerCase());
    if (r !== null) n++;
    if (progress) progress.done++;
  }
  return n;
}

// ── Rebuild ─────────────────────────────────────────────────────────────────

export interface RebuildState { startedAt: string; by: string; step: string; done: number; total: number; finishedAt?: string; error?: string; indexed: { backup: number; drift: number; monitor: number } }

/** Bucket requests per minute a rebuild may make (ZONE_SEARCH_BUCKET_RPM, 600 by default). */
const RPM = Math.max(30, Number(process.env.ZONE_SEARCH_BUCKET_RPM) || 600);
const bucket = { tokens: RPM, at: Date.now() };
/** Waits until `n` bucket requests fit in the per-minute budget. */
async function pace(n = 1) {
  for (;;) {
    const now = Date.now();
    bucket.tokens = Math.min(RPM, bucket.tokens + ((now - bucket.at) / 60_000) * RPM);
    bucket.at = now;
    if (bucket.tokens >= Math.min(n, RPM)) { bucket.tokens -= n; return; }
    await new Promise((r) => setTimeout(r, Math.ceil(((Math.min(n, RPM) - bucket.tokens) / RPM) * 60_000)));
  }
}

/**
 * Rebuilds the index in the background from everything stored: each zone's drift snapshot and
 * monitoring rows, and its newest backup (this server's folders, then every approved bucket, at most
 * ZONE_SEARCH_BUCKET_RPM requests a minute). Zones whose newest backup is already indexed are skipped.
 * One rebuild runs at a time; asking again while it runs returns it.
 */
export function rebuildIndex(by: string): { job: RebuildState; started: boolean } {
  const s = state();
  if (s.rebuild && !s.rebuild.finishedAt) return { job: s.rebuild, started: false };
  const r: RebuildState = { startedAt: new Date().toISOString(), by, step: 'Starting', done: 0, total: 0, indexed: { backup: 0, drift: 0, monitor: 0 } };
  s.rebuild = r;
  void rebuild(r).catch((err) => { r.error = message(err); log(`rebuild failed: ${r.error}`); }).finally(() => { r.finishedAt = new Date().toISOString(); r.step = r.error ? 'Failed' : 'Done'; });
  return { job: r, started: true };
}

async function rebuild(r: RebuildState) {
  // 1. Drift snapshots, 50 at a time (each holds a zone's DNS records).
  r.step = 'Drift snapshots';
  const snaps = await db().from('monitor_snapshots').select('zone_id', { count: 'exact', head: true }).eq('kind', 'latest');
  mustSearch(snaps, 'Counting drift snapshots');
  r.total = snaps.count ?? 0;
  for (let from = 0; ; from += 50) {
    const page = mustSearch(await db().from('monitor_snapshots').select('zone_id, data, taken_at').eq('kind', 'latest').order('zone_id').range(from, from + 49), 'Reading drift snapshots') as { zone_id: string; data: SnapshotLike & { zoneName?: string; accountId?: string }; taken_at: string }[];
    for (const p of page) {
      if (!p.data?.zoneName) continue;
      await indexZone({ zoneId: p.zone_id, zoneName: p.data.zoneName, accountId: p.data.accountId || null }, 'drift', null, p.taken_at, snapshotRows(p.data, p.data.zoneName));
      r.indexed.drift++;
      r.done++;
    }
    if (page.length < 50) break;
  }

  // 2. Monitoring rows of the checks worth finding, one zone after another.
  r.step = 'Monitoring results';
  for (const check of [...INDEXED_CHECKS].filter((c) => c !== 'drift')) {
    const names = new Map<string, { zone_name: string | null; account_id: string | null }>();
    for (let from = 0; ; from += 1000) {
      const t = mustSearch(await db().from('monitor_targets').select('scope_id, zone_name, account_id').eq('check_id', check).eq('scope_kind', 'zone').order('scope_id').range(from, from + 999), 'Reading monitoring zones') as { scope_id: string; zone_name: string | null; account_id: string | null }[];
      for (const x of t) names.set(x.scope_id, x);
      if (t.length < 1000) break;
    }
    let cur: string | null = null;
    let rows: Partial<Record<string, Record<string, unknown>[]>> = {};
    const flush = async () => {
      const t = cur ? names.get(cur) : null;
      if (cur && t?.zone_name) { await indexZone({ zoneId: cur, zoneName: t.zone_name, accountId: t.account_id }, `monitor:${check}`, null, new Date().toISOString(), monitorRows(check, rows, t.zone_name)); r.indexed.monitor++; }
      rows = {};
    };
    for (let from = 0; ; from += 1000) {
      const page = mustSearch(await db().from('monitor_rows').select('scope_id, section, data').eq('check_id', check).eq('scope_kind', 'zone').order('scope_id').order('id').range(from, from + 999), 'Reading monitoring rows') as { scope_id: string; section: string; data: Record<string, unknown> }[];
      for (const p of page) {
        if (p.scope_id !== cur) { await flush(); cur = p.scope_id; }
        (rows[p.section] ??= []).push(p.data);
      }
      if (page.length < 1000) break;
    }
    await flush();
  }

  // 3. Each zone's newest backup: this server's folders first, then the buckets.
  r.step = 'Backups';
  const have = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const page = mustSearch(await db().from('zone_search_sources').select('zone_name, source_at').eq('source', 'backup').order('zone_id').range(from, from + 999), 'Reading the search index') as { zone_name: string; source_at: string }[];
    for (const p of page) have.set(zoneFolder(p.zone_name).toLowerCase(), p.source_at);
    if (page.length < 1000) break;
  }
  /** Zones whose newest backup was looked at in this rebuild (newer folders come first). */
  const seen = new Set<string>();
  const upToDate = (zone: string, at: string) => { const h = have.get(zone.toLowerCase()); return !!h && Date.parse(h) >= Date.parse(at); };
  for (const f of localFolders()) {
    for (const z of localZones(f.name)) {
      if (seen.has(z.toLowerCase())) continue;
      seen.add(z.toLowerCase());
      if (upToDate(z, f.time)) continue;
      const files = readLocalZone(f.name, z);
      if (files?.length && (await indexBackupFiles(z, files, `local:${f.name}`, f.time)) !== null) r.indexed.backup++;
      r.done++;
    }
  }
  r.step = 'Backups in buckets';
  for (const s of await bucketStores().catch(() => [] as Store[])) {
    let folders: { name: string; time: string }[];
    try { await pace(); folders = await bucketFolders(s.target); } catch (err) { log(`${s.label}: ${message(err)}`); continue; }
    for (const f of folders) {
      // Zones already up to date in the index, or seen in a newer folder, are not read again.
      const skip = new Set([...seen, ...[...have].filter(([, at]) => Date.parse(at) >= Date.parse(f.time)).map(([z]) => z)]);
      try { r.indexed.backup += await indexBucketFolder(s, f.name, f.time, skip, r); } catch (err) { log(`${s.label} ${f.name}: ${message(err)}`); }
      for (const z of skip) seen.add(z);
    }
  }
}
