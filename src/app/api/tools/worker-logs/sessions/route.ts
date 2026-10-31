import { readBody, route } from '@/lib/http';
import { startTail } from '@/lib/worker-tail';

export const dynamic = 'force-dynamic';

/** Starts following a Worker's logs: { accountId, script, filters: { status[], methods[], search, sampling } }. */
export const POST = route(async (req, _ctx, me) => ({ session: await startTail(me, await readBody(req)) }), { perm: 'cloudflare:query', limit: { name: 'worker-tail', max: 10, windowMs: 10 * 60_000 } });
