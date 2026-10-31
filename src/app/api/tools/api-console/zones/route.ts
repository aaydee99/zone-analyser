import { route } from '@/lib/http';
import { credentialZones } from '@/lib/api-console';

export const dynamic = 'force-dynamic';

/** One page of the zones a credential reads: ?credentialId=&accountId=&q=&offset=&limit= (up to 200). */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  return credentialZones(u.get('credentialId'), {
    q: u.get('q') ?? '', accountId: u.get('accountId') ?? '',
    offset: Math.max(0, Math.floor(Number(u.get('offset')) || 0)), limit: Math.min(200, Math.max(1, Math.floor(Number(u.get('limit')) || 50))),
  });
}, { perm: 'cloudflare:query' });
