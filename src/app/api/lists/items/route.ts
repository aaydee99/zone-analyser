import { HttpError, route } from '@/lib/http';
import { listItems } from '@/lib/lists';

export const dynamic = 'force-dynamic';

const HEX = /^[0-9a-f]{32}$/;

/**
 * One page of a list's items, read from Cloudflare now (one call, within the token's budget):
 * ?account=&list=<list id>&cursor=&search= (Cloudflare's search: IPs by prefix, hostnames by substring, ASNs exactly).
 */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const account = u.get('account') ?? '', list = u.get('list') ?? '';
  if (!HEX.test(account) || !HEX.test(list)) throw new HttpError(400, 'Unknown list');
  const cursor = (u.get('cursor') ?? '').slice(0, 500);
  if (cursor && !/^[A-Za-z0-9_=-]+$/.test(cursor)) throw new HttpError(400, 'Not a page cursor');
  const search = (u.get('search') ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return listItems(account, list, { cursor, search });
}, { perm: 'runs:read', limit: { name: 'list-items', max: 120, windowMs: 5 * 60_000 } });
