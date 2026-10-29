import { route } from '@/lib/http';
import { withdraw } from '@/lib/approvals';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** The requester takes back a pending request. */
export const POST = route<Ctx>(async (_req, { params }, me) => ({ approval: await withdraw(me, (await params).id) }), { perm: 'runs:read' });
