'use client';
import { api } from './client';
import type { ZoneListItem } from './zone-catalog';

// The zone list (every zone the stored tokens can read), shared by the pages that use it (zone
// explorer, traffic analytics) for this browser tab: loaded once, and a page opened next uses it
// instead of asking the worker again. A read that is running is shared too. `fresh` reads it again
// from Cloudflare (and every page gets the new list next time).

export interface ZoneList { zones: ZoneListItem[]; problems: { credential: string; error: string }[] }

const KEEP_MS = 10 * 60_000;
let held: { at: number; p: Promise<ZoneList> } | null = null;

export function zoneList(fresh = false): Promise<ZoneList> {
  if (!fresh && held && Date.now() - held.at < KEEP_MS) return held.p;
  const p = api<ZoneList>(`/api/zone-explorer${fresh ? '?fresh=1' : ''}`);
  const mine = { at: Date.now(), p };
  held = mine;
  // A failed read is not kept: the next page asks again.
  p.catch(() => { if (held === mine) held = null; });
  return p;
}
