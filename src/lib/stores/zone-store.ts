'use client';
import { create } from 'zustand';
import { api, onWrite, staleAfter } from '../client';
import type { ZoneGroupReport, ZoneListItem, ZoneSummary } from '../zone-catalog';

// The Zone explorer's data for this browser tab, shared by every page and by the zone panel that
// opens from anywhere (components/zone-drawer.tsx): the zone list, and each opened zone's summary and
// sections. A page opened next, or the panel, shows what is here instead of asking the worker again;
// "Refresh zones", "Read again" and a section's ↻ read it again and put the answer here, so every
// view shows it. Cleared at sign-out (resetStores in stores/reset.ts).

export interface ZoneListData { zones: ZoneListItem[]; problems: { credential: string; error: string }[] }
export type Part = { state: 'loading' | 'ok' | 'error'; data?: ZoneGroupReport; error?: string };
export interface ZoneEntry {
  summary: ZoneSummary | null;
  parts: Record<string, Part>;
  /** When it was read (ms). */
  at: number;
  loading: boolean;
  error: string;
}

/** A list or zone older than this is read again when it is next shown (Refresh always reads). */
export const KEEP_MS = 10 * 60_000;
/** Opened zones kept; the least recently opened go first. */
const MAX_ZONES = 12;
/** Sections read at once for one zone. */
const PARALLEL = 4;

interface State {
  list: ZoneListData | null;
  listAt: number;
  listing: boolean;
  listError: string;
  zones: Record<string, ZoneEntry>;
  /** Opened zones, most recent last. */
  order: string[];
  /** The zone panel: null closed, '' open without a zone yet, else the zone it shows. */
  drawer: string | null;
  /** The Zone explorer page's open zone, kept while you visit other pages. */
  selected: string;
  loadList: (fresh?: boolean) => Promise<ZoneListData>;
  openZone: (id: string, fresh?: boolean) => Promise<void>;
  refreshPart: (id: string, key: string) => Promise<void>;
  /** Opens the zone panel, on a zone or ('') with only its zone picker. */
  openDrawer: (id?: string) => void;
  closeDrawer: () => void;
  select: (id: string) => void;
  reset: () => void;
}

const EMPTY = { list: null, listAt: 0, listing: false, listError: '', zones: {}, order: [], drawer: null, selected: '' };
const blank = (): ZoneEntry => ({ summary: null, parts: {}, at: 0, loading: false, error: '' });
// A read that is running is shared (two views asking at once send one request).
let listing: Promise<ZoneListData> | null = null;
const opening = new Map<string, Promise<void>>();

export const useZoneStore = create<State>()((set, get) => {
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
    loadList: (fresh = false) => {
      const s = get();
      if (!fresh && s.list && Date.now() - s.listAt < KEEP_MS) return Promise.resolve(s.list);
      if (!fresh && listing) return listing;
      set({ listing: true, listError: '' });
      const p = api<ZoneListData>(`/api/zone-explorer${fresh ? '?fresh=1' : ''}`);
      listing = p;
      p.then((list) => { if (listing === p) set({ list, listAt: Date.now(), listing: false }); },
        (e) => { if (listing === p) set({ listing: false, listError: (e as Error).message }); })
        .finally(() => { if (listing === p) listing = null; });
      return p;
    },
    openZone: (id, fresh = false) => {
      const cur = get().zones[id];
      // Kept: shown as it is (and moved to the front of the kept zones).
      if (!fresh && cur?.summary && !cur.error && Date.now() - cur.at < KEEP_MS) {
        set((s) => ({ order: [...s.order.filter((x) => x !== id), id] }));
        return opening.get(id) ?? Promise.resolve();
      }
      const running = opening.get(id);
      if (running) return running;
      const run = (async () => {
        set((s) => {
          const order = [...s.order.filter((x) => x !== id), id];
          // Too many kept: the least recently opened go (never the panel's or the page's zone).
          const drop = order.slice(0, Math.max(0, order.length - MAX_ZONES)).filter((x) => x !== s.drawer && x !== s.selected);
          const zones = { ...s.zones };
          for (const x of drop) delete zones[x];
          const prev = zones[id] ?? blank();
          // Read again: the old data stays shown until the new comes in.
          zones[id] = fresh && prev.summary ? { ...prev, loading: true, error: '' } : { ...blank(), loading: true };
          return { zones, order: order.filter((x) => !drop.includes(x)) };
        });
        try {
          const summary = await api<ZoneSummary>(`/api/zone-explorer/${encodeURIComponent(id)}`);
          patch(id, (z) => ({ summary, at: Date.now(), parts: fresh ? z.parts : Object.fromEntries(summary.sections.map((x) => [x.key, { state: 'loading' } as Part])) }));
          let i = 0;
          const secs = summary.sections;
          await Promise.all(Array.from({ length: Math.min(PARALLEL, secs.length) }, async () => { while (i < secs.length) { const x = secs[i++]; await readPart(id, x.href, x.key, fresh); } }));
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
    openDrawer: (id = '') => { set({ drawer: id }); if (id) void get().openZone(id); },
    closeDrawer: () => set({ drawer: null }),
    select: (id) => set({ selected: id }),
    reset: () => { listing = null; opening.clear(); set({ ...EMPTY }); },
  };
});

// A change that can make the list or a zone stale (tags and owners, or anything unlisted such as a
// revert): what is shown stays, and it is read again the next time a view asks for it.
onWrite((path) => {
  const stale = staleAfter(path);
  if (stale === 'none') return;
  useZoneStore.setState((s) => ({
    listAt: 0,
    zones: stale === 'all' ? Object.fromEntries(Object.entries(s.zones).map(([k, z]) => [k, { ...z, at: 0 }])) : s.zones,
  }));
});

/** Opens the zone panel on any page. */
export const openZonePanel = (id: string) => useZoneStore.getState().openDrawer(id);
