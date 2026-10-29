import { route } from '@/lib/http';
import { listZones } from '@/lib/zone-explorer';
import { isFresh } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';

/** Every zone the stored Cloudflare tokens can read (any role). Cached under this path; ?fresh=1 lists again. */
export const GET = route(async (req) => {
  const { zones, problems, at } = await listZones(isFresh(req));
  return { zones, problems, listedAt: new Date(at).toISOString() };
}, { perm: 'runs:read' });
