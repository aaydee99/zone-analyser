import { readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { bulkTag, resolveZones } from '@/lib/zone-meta';
import { parseTags, type ZoneMetaFilter } from '@/lib/zone-meta-types';
import { compactNum } from '@/lib/num';

export const dynamic = 'force-dynamic';

interface Body { zoneIds?: string[]; filter?: ZoneMetaFilter; search?: string; add?: string[]; remove?: string[]; owner?: string; dryRun?: boolean }

/**
 * Adds and removes tags (and optionally sets the owner) on many zones at once: the listed zone ids,
 * or every zone matching a tag filter and a name search. Console data only. `dryRun` only counts.
 */
export const POST = route(async (req, _ctx, me) => {
  const b = await readBody<Body>(req);
  const filter: ZoneMetaFilter = { tags: parseTags(b.filter?.tags ?? []).tags, owner: typeof b.filter?.owner === 'string' ? b.filter.owner : '', q: typeof b.filter?.q === 'string' ? b.filter.q : '' };
  const zones = await resolveZones({ zoneIds: b.zoneIds, filter, search: b.search });
  if (b.dryRun) return { zones: zones.length };
  const r = await bulkTag(zones, b.add, b.remove, b.owner, me.email);
  if (r.changed) {
    await audit(me, 'zone_meta.bulk_updated', `${compactNum(r.zones)} zone${r.zones === 1 ? '' : 's'}`, {
      zones: r.zones, changed: r.changed, add: r.add, remove: r.remove, ...(typeof b.owner === 'string' ? { owner: b.owner } : {}),
      selection: Array.isArray(b.zoneIds) ? 'listed' : { filter, search: b.search ?? '' }, sample: zones.slice(0, 20).map((z) => z.name),
    });
  }
  return r;
}, { perm: 'zones:tag', limit: { name: 'zone-meta-bulk', max: 30 } });
