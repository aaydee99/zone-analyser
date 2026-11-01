import { route } from '@/lib/http';
import { cloudflareHistory } from '@/lib/cf-audit';

export const dynamic = 'force-dynamic';

/** Old values for one Cloudflare audit entry, from Cloudflare's Resource History. ?accountId&id&time */
export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  return cloudflareHistory(q.get('accountId') ?? '', q.get('id') ?? '', q.get('time') ?? '');
}, { perm: 'activity:read' });
