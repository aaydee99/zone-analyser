import { HttpError, route } from '@/lib/http';
import { listLists } from '@/lib/lists';
import { LIST_KINDS, type ListsView } from '@/lib/lists-types';

export const dynamic = 'force-dynamic';

const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Every account list, read-only: ?account=&kind=ip|asn|hostname|redirect&q=&offset=&limit= (up to 200).
 * Read from Cloudflare and kept ten minutes; ?fresh=1 (the page's Refresh) reads again now.
 */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const account = u.get('account') || undefined;
  const kind = u.get('kind') || undefined;
  if (account && !ACCOUNT.test(account)) throw new HttpError(400, 'Unknown account');
  if (kind && !(LIST_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, 'Unknown kind of list');
  const offset = Math.max(0, Math.floor(Number(u.get('offset')) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(u.get('limit')) || 50)));
  const page = await listLists({ account, kind, q: u.get('q') ?? '', offset, limit, fresh: u.get('fresh') === '1' && offset === 0 });
  const view: ListsView = {
    rows: page.rows, total: page.total, offset, readAt: page.readAt, generatedAt: new Date().toISOString(),
    ...(offset ? {} : { accounts: page.accounts, problems: page.problems }),
  };
  return view;
}, { perm: 'runs:read' });
