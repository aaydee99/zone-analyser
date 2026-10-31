import 'server-only';
import { cached } from './cache';
import { HttpError } from './http';
import { trafficMonths } from './traffic';
import type { ZoneListItem } from './zone-catalog';
import { listZones, type ZoneList } from './zone-explorer';

// Which zones an investigation reads, from the cached zone list (no Cloudflare call): one zone, the
// zone a host name belongs to, an account's zones, or every zone. Busiest first when the monthly
// traffic of their account is already in the cache (nothing is read to rank them).

const HOST = /^(?=.{1,253}$)([a-z0-9_-]{1,63}\.)*[a-z0-9-]{1,63}$/i;
export const ACCOUNT_ID = /^[a-f0-9]{32}$/i;

/** The host part of a URL or host name, lower case, or ''. */
export function hostOf(v: string): string {
  const s = v.trim().toLowerCase();
  if (!s) return '';
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`).hostname.replace(/\.$/, ''); } catch { return ''; }
}

/** The zone a host belongs to: the longest zone name the host ends in. */
export function zoneOfHost(zones: ZoneListItem[], host: string): ZoneListItem | undefined {
  const h = hostOf(host);
  if (!h || !HOST.test(h)) return undefined;
  let best: ZoneListItem | undefined;
  for (const z of zones) {
    const n = z.name.toLowerCase();
    if ((h === n || h.endsWith(`.${n}`)) && (!best || n.length > best.name.length)) best = z;
  }
  return best;
}

export interface Scoped { kind: 'zone' | 'host' | 'account' | 'all'; zones: ZoneListItem[]; list: ZoneList; label: string }

/** The zones of a scope; throws 400/404 with a reason the page shows. */
export async function zonesOf(o: { zoneId?: string; host?: string; accountId?: string; all?: boolean }): Promise<Scoped> {
  const list = await listZones();
  const readable = list.zones.filter((z) => list.credentialOf[z.id]);
  if (o.zoneId) {
    const z = readable.find((x) => x.id === o.zoneId);
    if (!z) throw new HttpError(404, 'No stored token can read this zone');
    return { kind: 'zone', zones: [z], list, label: z.name };
  }
  if (o.host) {
    const z = zoneOfHost(readable, o.host);
    if (!z) throw new HttpError(404, `No zone the stored tokens read covers ${hostOf(o.host) || 'that host'}`);
    return { kind: 'host', zones: [z], list, label: z.name };
  }
  if (o.accountId) {
    if (!ACCOUNT_ID.test(o.accountId)) throw new HttpError(400, 'Not a Cloudflare account ID');
    const zones = readable.filter((z) => z.accountId === o.accountId);
    if (!zones.length) throw new HttpError(404, 'No stored token can read zones in this account');
    return { kind: 'account', zones, list, label: zones[0].accountName || o.accountId };
  }
  if (o.all) return { kind: 'all', zones: readable, list, label: 'All zones' };
  throw new HttpError(400, 'Choose a zone, a host name or an account (or search every zone)');
}

// ── Ranking by cached traffic ───────────────────────────────────────────────

const MISS = new Error('not cached');
/** A cached value, without loading it (and without waiting long for a load another request runs). */
async function peek<T>(name: string): Promise<T | undefined> {
  const hit = cached<T>(name, 1, () => Promise.reject(MISS)).catch(() => undefined);
  return Promise.race([hit, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250))]);
}

interface CachedMonth { zones: Record<string, { status?: string; daily?: { requests?: number }[] }> }

/** Requests per zone this month (or last month) from the traffic page's cache, for the accounts given. */
export async function cachedRequests(accountIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const [cur, prev] = trafficMonths();
  await Promise.all([...new Set(accountIds)].map(async (a) => {
    const key = (m: string) => `path:/api/traffic?month=${m}&account=${encodeURIComponent(a)}`;
    const month = (await peek<CachedMonth>(key(cur))) ?? (await peek<CachedMonth>(key(prev)));
    for (const [id, z] of Object.entries(month?.zones ?? {})) {
      if (z.status === 'ok') out.set(id, (z.daily ?? []).reduce((n, d) => n + (d.requests ?? 0), 0));
    }
  }));
  return out;
}

/** Busiest first where the traffic is cached; then active zones, then by name. */
export async function rankZones(zones: ZoneListItem[]): Promise<{ zones: ZoneListItem[]; ranking: string }> {
  if (zones.length <= 1) return { zones, ranking: 'one zone' };
  const req = await cachedRequests(zones.map((z) => z.accountId));
  const known = zones.filter((z) => req.has(z.id)).length;
  const sorted = [...zones].sort((a, b) => (req.get(b.id) ?? -1) - (req.get(a.id) ?? -1)
    || Number(b.status === 'active') - Number(a.status === 'active') || a.name.localeCompare(b.name));
  return {
    zones: sorted,
    ranking: known ? `busiest first by this month's cached traffic (${known} of ${zones.length} zones known; the rest by name)` : 'active zones first, then by name (no traffic is cached yet — opening Traffic analytics for an account ranks its zones by traffic)',
  };
}
