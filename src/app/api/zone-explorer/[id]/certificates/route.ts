import { route } from '@/lib/http';
import { zoneGroup } from '@/lib/zone-explorer';
import { certificatesOf, daysLeft } from '@/lib/zone-format';
import { isFresh, zoneIdOf } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Every certificate of the zone — Cloudflare managed or custom, with its expiry — from the cached SSL/TLS section. ?fresh=1 reads it again. */
export const GET = route<Ctx>(async (req, { params }) => {
  const ssl = await zoneGroup(await zoneIdOf(params), 'ssl', isFresh(req));
  const now = Date.now();
  return {
    zoneId: ssl.zoneId, zoneName: ssl.zoneName, generatedAt: ssl.generatedAt, ...(ssl.cachedIn ? { cachedIn: ssl.cachedIn } : {}),
    certificates: certificatesOf(ssl.sections).map((c) => ({ ...c, daysLeft: daysLeft(c.expiresOn, now) })),
  };
}, { perm: 'runs:read', limit: { name: 'zone-section', max: 400 } });
