import { route } from '@/lib/http';
import { dnsExport } from '@/lib/zone-explorer';
import { audit } from '@/lib/audit';
import { attachment, isFresh, zoneIdOf } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** The zone's DNS records as a BIND zone file, from Cloudflare's export (any role). Cached under this path; ?fresh=1 reads again. */
export const GET = route<Ctx>(async (req, { params }, me) => {
  const id = await zoneIdOf(params);
  const { name, text } = await dnsExport(id, isFresh(req));
  await audit(me, 'cloudflare_zone.dns_exported', name, { zoneId: id });
  return attachment(`${name}.txt`, text, 'text/plain; charset=utf-8');
}, { perm: 'runs:read', limit: { name: 'zone-export', max: 20 } });
