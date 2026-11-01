import { readBody, route } from '@/lib/http';
import { mayRevert, planCfRevert } from '@/lib/cf-revert';

export const dynamic = 'force-dynamic';

/** {accountId, entryId, time} — the request that would revert this change, for review. Sends nothing. A Cloudflare One change: super admins only. */
export const POST = route(async (req, _ctx, me) => {
  const { accountId, entryId, time } = await readBody<{ accountId?: string; entryId?: string; time?: string }>(req);
  const plan = await planCfRevert(String(accountId ?? ''), String(entryId ?? ''), String(time ?? ''));
  mayRevert(me, plan);
  return { plan };
}, { perm: 'cloudflare:revert', limit: { name: 'cf-revert-plan', max: 30 } });
