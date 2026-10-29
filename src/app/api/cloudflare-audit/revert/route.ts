import { readBody, route } from '@/lib/http';
import { applyCfRevert } from '@/lib/cf-revert';

export const dynamic = 'force-dynamic';

/** {accountId, entryId, time, planHash, email, apiKey, acknowledgeChangedSince?} — sends the reviewed revert to Cloudflare. */
export const POST = route(async (req, _ctx, me) => applyCfRevert(me, await readBody(req)), { perm: 'cloudflare:revert', limit: { name: 'cf-revert', max: 10 } });
