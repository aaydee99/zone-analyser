import { route } from '@/lib/http';
import { decide } from '@/lib/approvals';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Approves a pending request and starts it at once (a backup run, or a restore apply). */
export const POST = route<Ctx>(async (_req, { params }, me) => ({ approval: await decide(me, (await params).id, 'approve') }), { perm: 'runs:read', limit: { name: 'approval-decide', max: 30 } });
