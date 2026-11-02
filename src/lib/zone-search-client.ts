'use client';
import { zoneList } from './zone-list-client';
import type { ZoneListItem } from './zone-catalog';

// Finding zones anywhere in the console (zone pickers, the API console, Logpush, the security audit,
// the investigation pages) from the zone store — the Zone explorer's list, read once when the
// console opens (stores/zone-store.ts) — instead of asking the server on every search. The same
// matching as /api/investigate/zones: zone name, account name or zone ID; exact and leading matches
// first. Only zones a stored credential can read.

export interface FoundZone { id: string; name: string; accountId: string; accountName: string; plan: string; status: string }
export interface FoundAccount { id: string; name: string; zones: number }

const readable = (zones: ZoneListItem[]) => zones.filter((z) => z.credentials.length > 0);
const found = (z: ZoneListItem): FoundZone => ({ id: z.id, name: z.name, accountId: z.accountId, accountName: z.accountName, plan: z.plan, status: z.status });

/** Zones matching `q` (a page of them) and how many match in all. `credentialName`: zones that stored credential reads; `unreadable`: also zones no stored credential reads. */
export async function searchZones(q: string, o: { accountId?: string; credentialName?: string; limit?: number; offset?: number; active?: boolean; unreadable?: boolean } = {}): Promise<{ zones: FoundZone[]; total: number }> {
  const term = q.trim().toLowerCase().slice(0, 100);
  const all = (await zoneList()).zones;
  let list = o.unreadable ? all : readable(all);
  if (o.accountId) list = list.filter((z) => z.accountId === o.accountId);
  if (o.credentialName) list = list.filter((z) => z.credentials.includes(o.credentialName!));
  if (o.active) list = list.filter((z) => z.status === 'active');
  const hits = term ? list.filter((z) => z.name.toLowerCase().includes(term) || z.id === term || z.accountName.toLowerCase().includes(term)) : list;
  const rank = (n: string) => (n === term ? 0 : n.startsWith(term) ? 1 : 2);
  const sorted = [...hits].sort((a, b) => (term ? rank(a.name.toLowerCase()) - rank(b.name.toLowerCase()) : 0) || a.name.localeCompare(b.name));
  const offset = Math.max(0, o.offset ?? 0);
  return { zones: sorted.slice(offset, offset + (o.limit ?? 50)).map(found), total: sorted.length };
}

/** One zone by its ID (null: not in the list). */
export async function zoneById(id: string): Promise<FoundZone | null> {
  const z = readable((await zoneList()).zones).find((x) => x.id === id);
  return z ? found(z) : null;
}

/** The accounts with readable zones, by name, with their zone count. */
export async function zoneAccounts(): Promise<FoundAccount[]> {
  const m = new Map<string, FoundAccount>();
  for (const z of readable((await zoneList()).zones)) {
    const a = m.get(z.accountId) ?? { id: z.accountId, name: z.accountName || z.accountId, zones: 0 };
    a.zones++;
    m.set(z.accountId, a);
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}
