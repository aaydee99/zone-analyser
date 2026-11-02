'use client';
import { useZoneStore, type ZoneListData } from './stores/zone-store';

// The zone list (every zone the stored tokens can read), shared by the pages that use it (zone
// explorer, traffic analytics, Cloudflare activity, the zone panel) for this browser tab: kept in
// the zone store (stores/zone-store.ts), so a page opened next uses it instead of asking the worker
// again. A read that is running is shared too. `fresh` reads it again from Cloudflare and every view
// shows the new list.

export type ZoneList = ZoneListData;

export function zoneList(fresh = false): Promise<ZoneList> {
  return useZoneStore.getState().loadList(fresh);
}
