import { readBody, route } from '@/lib/http';
import { listSaved, saveQuery } from '@/lib/api-console';

export const dynamic = 'force-dynamic';

/** This user's saved queries. */
export const GET = route(async (_req, _ctx, me) => ({ saved: await listSaved(me) }), { perm: 'cloudflare:query' });

/** Saves { name, path } (the path as typed, with its placeholders). */
export const POST = route(async (req, _ctx, me) => saveQuery(me, await readBody(req)), { perm: 'cloudflare:query' });
