import { route } from '@/lib/http';
import { stopTail } from '@/lib/worker-tail';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Stops the session: the tail is deleted at Cloudflare and its events with it. */
export const POST = route<Ctx>(async (_req, { params }, me) => ({ session: await stopTail(me, (await params).id) }), { perm: 'cloudflare:query' });
