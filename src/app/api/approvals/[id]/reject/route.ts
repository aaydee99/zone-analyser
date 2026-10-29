import { readBody, route } from '@/lib/http';
import { decide } from '@/lib/approvals';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Rejects a pending request, with an optional reason for the requester. */
export const POST = route<Ctx>(async (req, { params }, me) => {
  const { reason } = await readBody<{ reason?: string }>(req);
  return { approval: await decide(me, (await params).id, 'reject', typeof reason === 'string' ? reason : '') };
}, { perm: 'runs:read', limit: { name: 'approval-decide', max: 30 } });
