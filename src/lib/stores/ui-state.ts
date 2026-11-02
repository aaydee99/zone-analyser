'use client';
import { useCallback } from 'react';
import { create } from 'zustand';

// What a page's tabs, sections, views and filters are set to, for this browser tab: going to
// another page and back finds them as they were. Only small view settings live here (no data).
// Cleared at sign-out (stores/reset.ts).

interface State { values: Record<string, unknown>; set: (key: string, value: unknown) => void; reset: () => void }

export const useUiStore = create<State>()((set) => ({
  values: {},
  set: (key, value) => set((s) => ({ values: { ...s.values, [key]: value } })),
  reset: () => set({ values: {} }),
}));

/** Like useState, but kept under `key` while the tab is open (e.g. 'cfa.view'). */
export function useUiState<T>(key: string, initial: T): [T, (next: T | ((cur: T) => T)) => void] {
  const value = useUiStore((s) => (key in s.values ? (s.values[key] as T) : initial));
  const put = useUiStore((s) => s.set);
  const setValue = useCallback((next: T | ((cur: T) => T)) => {
    const values = useUiStore.getState().values;
    const cur = (key in values ? values[key] : initial) as T;
    put(key, typeof next === 'function' ? (next as (c: T) => T)(cur) : next);
  }, [key, initial, put]);
  return [value, setValue];
}
