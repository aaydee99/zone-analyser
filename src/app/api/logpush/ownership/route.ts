import { readBody, route } from '@/lib/http';
import { requestOwnership } from '@/lib/logpush';

export const dynamic = 'force-dynamic';

/**
 * { scope, scopeId, destination_conf, cloudflare: { kind: 'token', token } | { kind: 'global', email, apiKey } }:
 * Cloudflare writes an ownership challenge file into the destination. It needs Logs Edit, so it runs
 * with the credential typed in for it, never a stored token. Neither is stored or returned.
 */
export const POST = route(async (req, _ctx, me) => requestOwnership(me, await readBody(req)), { perm: 'cloudflare:act', limit: { name: 'logpush-ownership', max: 10, windowMs: 10 * 60_000 } });
