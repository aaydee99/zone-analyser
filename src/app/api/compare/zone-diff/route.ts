import { HttpError, route } from '@/lib/http';
import { ZONE_ID, compareZones } from '@/lib/compare';

export const dynamic = 'force-dynamic';

/** Two zones side by side: ?a=<zone id>&b=<zone id>&kind=&status=only-a|only-b|different&offset=&limit= (up to 200). */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const a = u.get('a') ?? '', b = u.get('b') ?? '';
  if (!ZONE_ID.test(a) || !ZONE_ID.test(b)) throw new HttpError(400, 'Choose two zones');
  const page = await compareZones(a, b, { kind: u.get('kind') ?? undefined, status: u.get('status') ?? undefined, offset: Number(u.get('offset')) || 0, limit: Number(u.get('limit')) || 50 });
  return { ...page, generatedAt: new Date().toISOString() };
}, { perm: 'runs:read' });
