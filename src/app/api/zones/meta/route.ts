import { HttpError, readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { metaOf, setMeta, type MetaPatch } from '@/lib/zone-meta';
import { ZONE_ID } from '@/lib/zone-meta-types';

export const dynamic = 'force-dynamic';

/** Tags, owner, contact and notes of these zones: ?ids=a,b (at most 200). Console data only. */
export const GET = route(async (req) => {
  const ids = (new URL(req.url).searchParams.get('ids') ?? '').split(',').map((x) => x.trim()).filter((x) => ZONE_ID.test(x));
  if (ids.length > 200) throw new HttpError(400, 'At most 200 zones at once');
  return { meta: Object.fromEntries(await metaOf(ids)) };
}, { perm: 'runs:read' });

/** Sets one zone's tags, owner, contact and notes (fields left out stay as they are). */
export const PUT = route(async (req, _ctx, me) => {
  const body = await readBody<MetaPatch & { zoneId?: string }>(req);
  const { meta, changed } = await setMeta(String(body.zoneId ?? ''), body, me.email);
  if (Object.keys(changed).length) await audit(me, 'zone_meta.updated', meta.zoneName || meta.zoneId, { zoneId: meta.zoneId, account: meta.accountName, ...changed });
  return { meta };
}, { perm: 'zones:tag' });
