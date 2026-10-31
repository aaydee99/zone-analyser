import { route } from '@/lib/http';
import { listZones } from '@/lib/zone-explorer';
import { isFresh } from '@/lib/zone-routes';
import { allMeta, liteOf, zoneIdsMatching } from '@/lib/zone-meta';
import { filterFromParams, type ZoneMetaLite } from '@/lib/zone-meta-types';

export const dynamic = 'force-dynamic';

/**
 * Every zone the stored Cloudflare tokens can read (any role). Cached under this path; ?fresh=1 lists again.
 * ?tags=a,b&owner=&mq= keeps the zones with those console tags / that owner (resolved in the database);
 * ?meta=1 adds each zone's tags and owner (`meta`, only zones that have any). Neither calls Cloudflare.
 * ?list=0 leaves the zones out: only `meta` and the matching `ids` (a page that already holds the list).
 */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const { zones, problems, at } = await listZones(isFresh(req));
  const ids = await zoneIdsMatching(filterFromParams(u));
  const shown = ids ? zones.filter((z) => ids.has(z.id)) : zones;
  let meta: Record<string, ZoneMetaLite> | undefined;
  let metaError: string | undefined;
  if (u.get('meta') === '1') {
    // Tags are an extra: without them (migration 0015 not applied) the list still answers.
    try {
      const all = liteOf(await allMeta());
      meta = ids ? Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id))) : all;
    } catch (err) { meta = {}; metaError = (err as Error).message; }
  }
  if (u.get('list') === '0') return { ids: ids ? shown.map((z) => z.id) : null, of: zones.length, ...(meta ? { meta } : {}), ...(metaError ? { metaError } : {}) };
  return { zones: shown, problems, listedAt: new Date(at).toISOString(), ...(ids ? { filtered: true, of: zones.length } : {}), ...(meta ? { meta } : {}), ...(metaError ? { metaError } : {}) };
}, { perm: 'runs:read' });
