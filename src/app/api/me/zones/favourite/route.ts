import { readBody, route } from '@/lib/http';
import { knownZone } from '@/lib/zone-meta';
import { isFavourite, setFavourite } from '@/lib/zone-prefs';
import { ZONE_ID } from '@/lib/zone-meta-types';

export const dynamic = 'force-dynamic';

/** Whether the signed-in user starred a zone: ?zoneId= */
export const GET = route(async (req, _ctx, me) => {
  const id = new URL(req.url).searchParams.get('zoneId') ?? '';
  return { on: ZONE_ID.test(id) ? await isFavourite(me.id, id) : false };
}, { perm: 'runs:read' });

/** Stars or unstars a zone for the signed-in user ({ zoneId, on }). */
export const PUT = route(async (req, _ctx, me) => {
  const { zoneId, on } = await readBody<{ zoneId?: string; on?: boolean }>(req);
  const zone = await knownZone(String(zoneId ?? ''));
  await setFavourite(me.id, zone, on !== false);
  return { on: on !== false };
}, { perm: 'runs:read' });
