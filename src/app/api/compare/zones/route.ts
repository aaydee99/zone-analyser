import { route } from '@/lib/http';
import { indexedZones } from '@/lib/compare';

export const dynamic = 'force-dynamic';

/** Zones with stored configuration, by name (?q=, at most 50), for the comparison pickers. */
export const GET = route(async (req) => {
  const q = (new URL(req.url).searchParams.get('q') ?? '').slice(0, 100);
  return { zones: await indexedZones(q, 50) };
}, { perm: 'runs:read' });
