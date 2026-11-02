'use client';
import { create } from 'zustand';
import { onWrite } from '../client';

// Answers the console pages loaded, by request path, for this browser tab: going back to a page,
// tab or section shows what it had at once instead of a skeleton and a new request. Refresh on a
// page reads again and puts the new answer here. Cleared at sign-out (stores/reset.ts).

/** A kept answer older than this is read again when its page is shown. */
export const FRESH_MS = 5 * 60_000;
const MAX = 60;

interface Entry { data: unknown; at: number }
interface State {
  entries: Record<string, Entry>;
  put: (key: string, data: unknown) => void;
  drop: (prefix: string) => void;
  reset: () => void;
}

export const useDataCache = create<State>()((set) => ({
  entries: {},
  put: (key, data) => set((s) => {
    const entries = { ...s.entries, [key]: { data, at: Date.now() } };
    const keys = Object.keys(entries);
    // Too many: the oldest go.
    if (keys.length > MAX) for (const k of keys.sort((a, b) => entries[a].at - entries[b].at).slice(0, keys.length - MAX)) delete entries[k];
    return { entries };
  }),
  drop: (prefix) => set((s) => ({ entries: Object.fromEntries(Object.entries(s.entries).filter(([k]) => !k.startsWith(prefix))) })),
  reset: () => set({ entries: {} }),
}));

// Any change made through the API: every kept answer is read again when its page is next shown
// (a page that is open keeps what it shows until its own Refresh).
onWrite(() => useDataCache.getState().reset());

/** The kept answer for `key` when it is fresh enough, else undefined. */
export function cached<T>(key: string, maxAge = FRESH_MS): T | undefined {
  const e = useDataCache.getState().entries[key];
  return e && Date.now() - e.at < maxAge ? (e.data as T) : undefined;
}
