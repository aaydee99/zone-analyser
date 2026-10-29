import { HttpError, route } from '@/lib/http';
import { isGroup, zoneGroup } from '@/lib/zone-explorer';
import { auditView, isFresh, zoneIdOf } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; group: string }> };

/** One section of a zone (e.g. dns, ssl, security_rules), read-only GETs to Cloudflare, cached under this path. ?fresh=1 reads it again. */
export const GET = route<Ctx>(async (req, { params }, me) => {
  const id = await zoneIdOf(params);
  const { group } = await params;
  if (!isGroup(group)) throw new HttpError(404, 'No such section');
  const part = await zoneGroup(id, group, isFresh(req));
  await auditView(me, { id, name: part.zoneName, accountName: '' });
  return part;
}, { perm: 'runs:read', limit: { name: 'zone-section', max: 400 } });
