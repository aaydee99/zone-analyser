import { HttpError, route } from '@/lib/http';
import { templateGaps } from '@/lib/compare';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A page of a template's gaps per zone, most first: ?offset=&limit= (up to 200) &account= &tag=<tag>,<tag>
 * &gaps=1 (only zones with gaps). Kept results; stale ones are computed again in the background.
 */
export const GET = route<Ctx>(async (req, { params }) => {
  const u = new URL(req.url).searchParams;
  const account = u.get('account') ?? '';
  if (account && !ID.test(account)) throw new HttpError(400, 'Unknown account');
  const tags = (u.get('tag') ?? '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10);
  let zoneIds: string[] | null = null;
  if (tags.length) {
    const meta = await import('@/lib/zone-meta');
    zoneIds = [...((await meta.zoneIdsMatching({ tags })) ?? [])];
  }
  const page = await templateGaps((await params).id, { offset: Number(u.get('offset')) || 0, limit: Number(u.get('limit')) || 50, accountId: account || undefined, zoneIds, onlyGaps: u.get('gaps') === '1' });
  return { ...page, generatedAt: new Date().toISOString() };
}, { perm: 'runs:read' });
