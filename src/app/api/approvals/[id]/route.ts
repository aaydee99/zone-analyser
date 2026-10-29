import { route } from '@/lib/http';
import { approvalFor } from '@/lib/approvals';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** One request (the requester polls it until it is decided). */
export const GET = route<Ctx>(async (_req, { params }, me) => ({ approval: approvalFor(me, (await params).id) }), { perm: 'runs:read' });
