import { route } from '@/lib/http';
import { quickZones } from '@/lib/zone-prefs';

export const dynamic = 'force-dynamic';

/** The signed-in user's favourite zones and the last 20 zones they opened (their own only). */
export const GET = route(async (_req, _ctx, me) => quickZones(me.id), { perm: 'runs:read' });
