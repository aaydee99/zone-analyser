import { route } from '@/lib/http';
import { listZones } from '@/lib/zone-explorer';
import { liteOf, metaOf, searchZones } from '@/lib/zone-meta';
import { filterFromParams } from '@/lib/zone-meta-types';

export const dynamic = 'force-dynamic';

/**
 * Zones by name and tag filter, a page at a time: ?q=&tags=&owner=&mq=&offset=&limit= (50 by default,
 * up to 200), with each zone's tags and owner. Uses the cached zone list (no Cloudflare call unless
 * it expired).
 */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const offset = Math.max(0, Math.floor(Number(u.get('offset')) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(u.get('limit')) || 50)));
  const { zones } = await listZones();
  const hits = await searchZones(zones, filterFromParams(u), u.get('q') ?? '');
  const page = hits.slice(offset, offset + limit);
  const meta = await metaOf(page.map((z) => z.id));
  return {
    zones: page.map((z) => ({ id: z.id, name: z.name, accountName: z.accountName, status: z.status, plan: z.plan })),
    meta: liteOf(meta), total: hits.length, offset, of: zones.length,
  };
}, { perm: 'runs:read' });
