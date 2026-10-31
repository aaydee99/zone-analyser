import { readBody, route } from '@/lib/http';
import { requestOwnership } from '@/lib/logpush';

export const dynamic = 'force-dynamic';

/**
 * { scope, scopeId, destination_conf }: Cloudflare writes an ownership challenge file into the
 * destination (needs Logs Edit; changes nothing in Cloudflare). The destination is not stored.
 */
export const POST = route(async (req, _ctx, me) => requestOwnership(me, await readBody(req)), { perm: 'cloudflare:act', limit: { name: 'logpush-ownership', max: 10, windowMs: 10 * 60_000 } });
