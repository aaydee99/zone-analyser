import { readBody, route } from '@/lib/http';
import { planCfRevert } from '@/lib/cf-revert';

export const dynamic = 'force-dynamic';

/** {accountId, entryId, time} — the request that would revert this change, for review. Sends nothing. */
export const POST = route(async (req) => {
  const { accountId, entryId, time } = await readBody<{ accountId?: string; entryId?: string; time?: string }>(req);
  return { plan: await planCfRevert(String(accountId ?? ''), String(entryId ?? ''), String(time ?? '')) };
}, { perm: 'cloudflare:revert', limit: { name: 'cf-revert-plan', max: 30 } });
