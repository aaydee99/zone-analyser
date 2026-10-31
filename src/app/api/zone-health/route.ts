import { HttpError, route } from '@/lib/http';
import { healthAccounts, healthPage, healthSummary } from '@/lib/zone-health';
import { isHealthSort, type HealthView } from '@/lib/zone-health-types';

export const dynamic = 'force-dynamic';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TAG = /^[a-z0-9][a-z0-9:._/-]{0,63}$/;

/**
 * Zone health scores, worst first, from the stored table (no Cloudflare call):
 * ?account=&tag=&q= (start of the zone name, or its ID)&sort=score|best|findings|name&offset=&limit= (up to 200).
 * The first page also carries the summary and the accounts for the filter.
 */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const account = u.get('account') || undefined;
  const tag = (u.get('tag') ?? '').trim().toLowerCase() || undefined;
  if (account && !ID.test(account)) throw new HttpError(400, 'Unknown account');
  if (tag && !TAG.test(tag)) throw new HttpError(400, 'Not a tag');
  const sort = u.get('sort');
  const offset = Math.max(0, Math.floor(Number(u.get('offset')) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(u.get('limit')) || 50)));
  const q = { account, tag, q: u.get('q') ?? '', sort: isHealthSort(sort) ? sort : 'score' as const, offset, limit };
  const [page, summary, accounts] = await Promise.all([healthPage(q), offset ? null : healthSummary({ account, tag }), offset ? null : healthAccounts()]);
  const view: HealthView = { ...page, ...(summary ? { summary } : {}), ...(accounts ? { accounts } : {}), generatedAt: new Date().toISOString() };
  return view;
}, { perm: 'runs:read' });
