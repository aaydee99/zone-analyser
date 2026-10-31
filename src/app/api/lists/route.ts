import { HttpError, route } from '@/lib/http';
import { listAccounts, listLists } from '@/lib/lists';
import { coverage, coverageOf } from '@/lib/monitor-store';
import { LIST_KINDS, type ListsView } from '@/lib/lists-types';

export const dynamic = 'force-dynamic';

const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;

/** Account lists as monitoring stored them (no Cloudflare call): ?account=&kind=ip|asn|hostname|redirect&q=&offset=&limit= (up to 200). */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const account = u.get('account') || undefined;
  const kind = u.get('kind') || undefined;
  if (account && !ACCOUNT.test(account)) throw new HttpError(400, 'Unknown account');
  if (kind && !(LIST_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, 'Unknown kind of list');
  const offset = Math.max(0, Math.floor(Number(u.get('offset')) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(u.get('limit')) || 50)));
  const [page, accounts, cov] = await Promise.all([listLists({ account, kind, q: u.get('q') ?? '', offset, limit }), offset ? null : listAccounts(), offset ? null : coverage()]);
  const view: ListsView = { ...page, offset, ...(accounts ? { accounts } : {}), ...(cov ? { lastRun: coverageOf(cov, 'lists').lastRun } : {}), generatedAt: new Date().toISOString() };
  return view;
}, { perm: 'runs:read' });
