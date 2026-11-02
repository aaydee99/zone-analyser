'use client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, onWrite, staleAfter } from '../client';
import type { ZoneGroupReport, ZoneListItem, ZoneSummary } from '../zone-catalog';
import type { ZoneMeta, ZoneMetaLite } from '../zone-meta-types';
import { idbStorage } from './idb-storage';

// The Zone explorer's data, shared by every page and by the zone panel that opens from anywhere
// (components/zone-drawer.tsx): the zone list, each opened zone's summary and sections, and the
// console tags and owners. It is read once — when the console opens, or the first time a view asks —
// and then always shown from here: moving between pages never asks the server again, and neither
// does reloading the page, because the store is kept in this browser's IndexedDB (idb-storage.ts).
// Only the Refresh buttons read it again: "Refresh" on the Zone explorer (the list, the tags and
// the open zone), "Read again" on a zone and a section's ↻.
//
// What is kept belongs to the person signed in: it is cleared at sign-out, when someone else signs
// in in this browser (claim), and a kept copy older than PERSIST_MAX_MS (the longest a session
// lasts) is not loaded. A change to tags or owners made here updates the store at once; other
// changes (a restore, a revert) are shown after Refresh.

export interface ZoneListData { zones: ZoneListItem[]; problems: { credential: string; error: string }[] }
export type Part = { state: 'loading' | 'ok' | 'error'; data?: ZoneGroupReport; error?: string };
export interface ZoneEntry {
  summary: ZoneSummary | null;
  parts: Record<string, Part>;
  /** When it was read (ms); 0 when it must be read again before it is shown. */
  at: number;
  loading: boolean;
  error: string;
}
/** The tag filter's answer: the zones it matches (null: no filter). */
export interface MetaMatch { ids: string[] | null; error: string }

/** Opened zones kept; the least recently opened go first. */
const MAX_ZONES = 12;
/** Sections read at once for one zone. */
const PARALLEL = 4;
/** A copy kept in the browser longer than this (a session's longest life, 12 hours) is not loaded. */
export const PERSIST_MAX_MS = 12 * 3600_000;
const NAME = 'zone-store';

interface Kept {
  /** The user the data was read for. */
  owner: string;
  list: ZoneListData | null;
  listAt: number;
  zones: Record<string, ZoneEntry>;
  /** Opened zones, most recent last. */
  order: string[];
  /** The Zone explorer page's open zone, kept while you visit other pages. */
  selected: string;
  /** Tags and owners of every zone, and the zones each tag filter matches (by its query string). */
  meta: Record<string, ZoneMetaLite> | null;
  matches: Record<string, MetaMatch>;
  /** Each opened zone's full tags, owner, contact and notes. */
  zoneMeta: Record<string, ZoneMeta>;
}
interface State extends Kept {
  listing: boolean;
  listError: string;
  metaLoading: boolean;
  /** The zone panel: null closed, '' open without a zone yet, else the zone it shows. */
  drawer: string | null;
  loadList: (fresh?: boolean) => Promise<ZoneListData>;
  openZone: (id: string, fresh?: boolean) => Promise<void>;
  refreshPart: (id: string, key: string) => Promise<void>;
  /** Tags and owners, and the zones `filter` (a query string) matches. */
  loadMeta: (filter: string, fresh?: boolean) => Promise<void>;
  loadZoneMeta: (id: string, fresh?: boolean) => Promise<void>;
  /** A zone's tags and owner were saved: shown everywhere at once. */
  setZoneMeta: (m: ZoneMeta) => void;
  /** The Zone explorer's Refresh: the list, the tags and owners, and the open zone, read again. */
  refreshAll: (filter: string) => Promise<void>;
  openDrawer: (id?: string) => void;
  closeDrawer: () => void;
  select: (id: string) => void;
  /** The signed-in user: data kept for someone else is dropped. */
  claim: (userId: string) => Promise<void>;
  reset: () => void;
}

const KEPT: Kept = { owner: '', list: null, listAt: 0, zones: {}, order: [], selected: '', meta: null, matches: {}, zoneMeta: {} };
const EMPTY = { ...KEPT, listing: false, listError: '', metaLoading: false, drawer: null };
const blank = (): ZoneEntry => ({ summary: null, parts: {}, at: 0, loading: false, error: '' });
// A read that is running is shared (two views asking at once send one request).
let listing: Promise<ZoneListData> | null = null;
const opening = new Map<string, Promise<void>>();
const metaReads = new Map<string, Promise<void>>();

/** Resolves once the kept copy has been loaded from the browser (at once where there is none). */
// The saved copy is loaded only once the signed-in person is known (claim), and only when it is
// theirs: someone else's zones are never shown, not even for a moment.
let expectedOwner = '';
let ready: Promise<void> | null = null;
let markReady: () => void = () => {};
/** How long a view waits for the sign-in check before reading without the saved copy. */
const CLAIM_WAIT_MS = 3_000;
function hydrated(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (!ready) {
    ready = new Promise((resolve) => { markReady = resolve; });
    setTimeout(() => markReady(), CLAIM_WAIT_MS);
  }
  return ready;
}

/** What is written to the browser: finished data only (a section still loading is read again on open). */
function keep(s: State): Kept & { savedAt: number } {
  const zones: Record<string, ZoneEntry> = {};
  for (const [id, z] of Object.entries(s.zones)) {
    if (!z.summary) continue;
    const parts = Object.fromEntries(Object.entries(z.parts).filter(([, p]) => p.state !== 'loading'));
    const complete = !z.loading && Object.keys(parts).length === z.summary.sections.length;
    zones[id] = { ...z, parts, loading: false, at: complete ? z.at : 0 };
  }
  return { owner: s.owner, list: s.list, listAt: s.listAt, zones, order: s.order.filter((x) => zones[x]), selected: s.selected, meta: s.meta, matches: s.matches, zoneMeta: s.zoneMeta, savedAt: Date.now() };
}

export const useZoneStore = create<State>()(persist((set, get) => {
  const patch = (id: string, fn: (z: ZoneEntry) => Partial<ZoneEntry>) => set((s) => {
    const cur = s.zones[id] ?? blank();
    return { zones: { ...s.zones, [id]: { ...cur, ...fn(cur) } } };
  });
  const setPart = (id: string, key: string, part: Part) => patch(id, (z) => ({ parts: { ...z.parts, [key]: part } }));
  const readPart = async (id: string, href: string, key: string, fresh: boolean) => {
    setPart(id, key, { ...(get().zones[id]?.parts[key] ?? {}), state: 'loading' });
    try { setPart(id, key, { state: 'ok', data: await api<ZoneGroupReport>(`${href}${fresh ? '?fresh=1' : ''}`) }); }
    catch (e) { setPart(id, key, { ...(get().zones[id]?.parts[key] ?? {}), state: 'error', error: (e as Error).message }); }
  };
  return {
    ...EMPTY,
    loadList: async (fresh = false) => {
      await hydrated();
      const s = get();
      // Kept: shown from here until Refresh.
      if (!fresh && s.list && s.listAt) return s.list;
      if (!fresh && listing) return listing;
      set({ listing: true, listError: '' });
      const p = api<ZoneListData>(`/api/zone-explorer${fresh ? '?fresh=1' : ''}`);
      listing = p;
      p.then((list) => { if (listing === p) set({ list, listAt: Date.now(), listing: false }); },
        (e) => { if (listing === p) set({ listing: false, listError: (e as Error).message }); })
        .finally(() => { if (listing === p) listing = null; });
      return p;
    },
    openZone: async (id, fresh = false) => {
      await hydrated();
      const cur = get().zones[id];
      // Kept and complete: shown as it is (and moved to the front of the kept zones).
      if (!fresh && cur?.summary && !cur.error && cur.at) {
        set((s) => ({ order: [...s.order.filter((x) => x !== id), id] }));
        return opening.get(id) ?? undefined;
      }
      const running = opening.get(id);
      if (running) return running;
      const run = (async () => {
        set((s) => {
          const order = [...s.order.filter((x) => x !== id), id];
          // Too many kept: the least recently opened go (never the panel's or the page's zone).
          const drop = order.slice(0, Math.max(0, order.length - MAX_ZONES)).filter((x) => x !== s.drawer && x !== s.selected);
          const zones = { ...s.zones };
          const zoneMeta = { ...s.zoneMeta };
          for (const x of drop) { delete zones[x]; delete zoneMeta[x]; }
          const prev = zones[id] ?? blank();
          // Read again: the old data stays shown until the new comes in.
          zones[id] = (fresh || !prev.at) && prev.summary ? { ...prev, loading: true, error: '' } : { ...blank(), loading: true };
          return { zones, zoneMeta, order: order.filter((x) => !drop.includes(x)) };
        });
        try {
          const summary = await api<ZoneSummary>(`/api/zone-explorer/${encodeURIComponent(id)}`);
          // A kept zone missing some sections reads only those; Read again reads all of them.
          const have = get().zones[id]?.parts ?? {};
          const secs = summary.sections.filter((x) => fresh || have[x.key]?.state !== 'ok');
          patch(id, (z) => ({ summary, parts: { ...(fresh ? z.parts : Object.fromEntries(Object.entries(z.parts).filter(([, p]) => p.state === 'ok'))), ...Object.fromEntries((fresh ? [] : secs).map((x) => [x.key, { state: 'loading' } as Part])) } }));
          let i = 0;
          await Promise.all(Array.from({ length: Math.min(PARALLEL, secs.length) }, async () => { while (i < secs.length) { const x = secs[i++]; await readPart(id, x.href, x.key, fresh); } }));
          patch(id, () => ({ at: Date.now() }));
        } catch (e) {
          patch(id, () => ({ error: (e as Error).message }));
        } finally {
          patch(id, () => ({ loading: false }));
          opening.delete(id);
        }
      })();
      opening.set(id, run);
      return run;
    },
    refreshPart: async (id, key) => {
      const z = get().zones[id];
      const s = z?.summary?.sections.find((x) => x.key === key);
      if (!s || z.loading) return;
      patch(id, () => ({ loading: true }));
      try { await readPart(id, s.href, key, true); } finally { patch(id, () => ({ loading: false })); }
    },
    loadMeta: async (filter, fresh = false) => {
      await hydrated();
      const s = get();
      if (!fresh && s.meta && s.matches[filter]) return;
      const key = `${filter}|${fresh ? 1 : 0}`;
      const running = metaReads.get(key);
      if (running) return running;
      const p = new URLSearchParams(filter);
      p.set('meta', '1'); p.set('list', '0');
      set({ metaLoading: true });
      const run = api<{ ids: string[] | null; meta?: Record<string, ZoneMetaLite>; metaError?: string }>(`/api/zone-explorer?${p}`, { fresh })
        .then((r) => set((st) => ({ meta: r.meta ?? st.meta ?? {}, matches: { ...(fresh ? {} : st.matches), [filter]: { ids: r.ids, error: r.metaError ?? '' } } })),
          (e) => set((st) => ({ matches: { ...st.matches, [filter]: { ids: null, error: (e as Error).message } } })))
        .then(() => undefined)
        .finally(() => { metaReads.delete(key); set({ metaLoading: false }); });
      metaReads.set(key, run);
      return run;
    },
    loadZoneMeta: async (id, fresh = false) => {
      await hydrated();
      if (!fresh && get().zoneMeta[id]) return;
      try {
        const r = await api<{ meta: Record<string, ZoneMeta> }>(`/api/zones/meta?ids=${encodeURIComponent(id)}`, { fresh });
        set((s) => ({ zoneMeta: { ...s.zoneMeta, [id]: r.meta[id] ?? { zoneId: id, zoneName: '', accountName: '', tags: [], owner: '', contact: '', notes: '' } } }));
      } catch { /* the panel shows no tags; Refresh tries again */ }
    },
    setZoneMeta: (m) => set((s) => ({
      zoneMeta: { ...s.zoneMeta, [m.zoneId]: m },
      // The list's chips change at once; which zones a tag filter matches is read again when shown.
      meta: s.meta ? { ...s.meta, [m.zoneId]: { tags: m.tags, owner: m.owner } } : s.meta,
      matches: {},
    })),
    refreshAll: async (filter) => {
      const sel = get().selected;
      const jobs: Promise<unknown>[] = [get().loadList(true), get().loadMeta(filter, true)];
      if (sel) jobs.push(get().openZone(sel, true), get().loadZoneMeta(sel, true));
      const out = await Promise.allSettled(jobs);
      const bad = out.find((x): x is PromiseRejectedResult => x.status === 'rejected');
      if (bad) throw bad.reason;
    },
    openDrawer: (id = '') => { set({ drawer: id }); if (id) { void get().openZone(id); void get().loadZoneMeta(id); } },
    closeDrawer: () => set({ drawer: null }),
    select: (id) => set({ selected: id }),
    claim: async (userId) => {
      const first = !expectedOwner;
      expectedOwner = userId;
      void hydrated();
      // First claim in this page: load the saved copy (merge keeps it only when it is this person's).
      if (first) await Promise.resolve(useZoneStore.persist?.rehydrate()).catch(() => {});
      const s = get();
      if (s.owner && s.owner !== userId) get().reset();
      if (get().owner !== userId) set({ owner: userId });
      markReady();
    },
    reset: () => {
      listing = null; opening.clear(); metaReads.clear();
      set({ ...EMPTY });
      void useZoneStore.persist?.clearStorage();
    },
  };
}, {
  name: NAME,
  version: 1,
  storage: idbStorage<Kept & { savedAt: number }>(),
  partialize: keep,
  // Loaded by claim, not when the page opens.
  skipHydration: true,
  // Someone else's copy, one older than a session, or one of an older shape is not loaded.
  merge: (kept, cur) => {
    const k = kept as (Kept & { savedAt?: number }) | undefined;
    if (!k?.savedAt || Date.now() - k.savedAt > PERSIST_MAX_MS || !expectedOwner || k.owner !== expectedOwner) return cur;
    const { savedAt: _, ...rest } = k;
    return { ...cur, ...rest };
  },
}));

// Tags and owners changed (here or on the Tags page): read again when next shown. Nothing else is
// marked stale — the zone list and the zones are read again only by Refresh.
onWrite((path) => {
  if (staleAfter(path) !== 'explorer') return;
  useZoneStore.setState({ meta: null, matches: {}, zoneMeta: {} });
});

/** Opens the zone panel on any page. */
export const openZonePanel = (id: string) => useZoneStore.getState().openDrawer(id);
