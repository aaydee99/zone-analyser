import { readBody, route } from '@/lib/http';
import { runQuery } from '@/lib/api-console';

export const dynamic = 'force-dynamic';

/**
 * One read-only call: { credentialId, path, accountId?, zoneId? }. Only GET is sent, only under
 * /client/v4, and the answer (masked, cut at 2 MB) is never stored or logged.
 */
export const POST = route(async (req, _ctx, me) => runQuery(me, await readBody(req)), { perm: 'cloudflare:query', limit: { name: 'cf-query', max: 60, windowMs: 60_000 } });
