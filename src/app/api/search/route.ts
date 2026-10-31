import { HttpError, route } from '@/lib/http';
import { searchZones } from '@/lib/zone-search';
import { isIndexKind } from '@/lib/zone-index';

export const dynamic = 'force-dynamic';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const list = (v: string | null) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Searches every zone's stored configuration: ?q= (1–200 characters) &mode=contains|exact
 * &kind=dns,setting… &account= &zone=<id>,<id> &tag=<tag>,<tag> &owner= &offset= &limit= (up to 200).
 */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const q = (u.get('q') ?? '').trim();
  if (q.length > 200) throw new HttpError(400, 'Search for 200 characters or fewer');
  const zones = list(u.get('zone'));
  if (zones.length > 500 || zones.some((z) => !ID.test(z))) throw new HttpError(400, 'Unknown zone');
  const account = u.get('account') ?? '';
  if (account && !ID.test(account)) throw new HttpError(400, 'Unknown account');
  const kinds = list(u.get('kind'));
  if (kinds.some((k) => !isIndexKind(k))) throw new HttpError(400, 'Unknown kind');
  const tags = list(u.get('tag')).slice(0, 10);
  const result = await searchZones(q, {
    mode: u.get('mode') === 'exact' ? 'exact' : 'contains', kinds: kinds.filter(isIndexKind), accountId: account || undefined,
    zoneIds: zones.length ? zones : undefined, tags: tags.length ? tags : undefined, owner: (u.get('owner') ?? '').slice(0, 200) || undefined,
    offset: Number(u.get('offset')) || 0, limit: Number(u.get('limit')) || 50,
  });
  return { ...result, generatedAt: new Date().toISOString() };
}, { perm: 'runs:read' });
