'use client';
import type { PersistStorage, StorageValue } from 'zustand/middleware';

// Storage for a persisted store in this browser's IndexedDB (database "castellan-console", one
// object store). IndexedDB, not localStorage: an opened zone's sections can be megabytes (DNS
// records, rules), past localStorage's ~5 MB, and IndexedDB stores objects without turning them
// into a JSON string first. Writes are coalesced (WRITE_MS after the last change) so a zone whose
// sections arrive one by one is written once or twice, not per section; a write still waiting is
// done when the tab is hidden or closed. Without IndexedDB (server render, blocked storage) nothing
// is kept and every read answers null — the store works as before, in memory.

const DB = 'castellan-console';
const STORE = 'kv';
const WRITE_MS = 800;

let opening: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return (opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  }));
}
async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const req = fn(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

const pending = new Map<string, { value: unknown; timer: ReturnType<typeof setTimeout> }>();
function flush(name: string) {
  const p = pending.get(name);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(name);
  void run('readwrite', (s) => s.put(p.value, name));
}
if (typeof window !== 'undefined') {
  const all = () => { for (const k of [...pending.keys()]) flush(k); };
  window.addEventListener('pagehide', all);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') all(); });
}

export function idbStorage<S>(): PersistStorage<S> {
  return {
    getItem: async (name) => (await run<StorageValue<S> | undefined>('readonly', (s) => s.get(name))) ?? null,
    setItem: (name, value) => {
      const cur = pending.get(name);
      if (cur) clearTimeout(cur.timer);
      pending.set(name, { value, timer: setTimeout(() => flush(name), WRITE_MS) });
    },
    // At once: a sign-out must not leave the data behind for the next person in this browser.
    removeItem: async (name) => {
      const cur = pending.get(name);
      if (cur) { clearTimeout(cur.timer); pending.delete(name); }
      await run('readwrite', (s) => s.delete(name));
    },
  };
}
