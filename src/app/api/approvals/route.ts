import { route } from '@/lib/http';
import { approvalsFor, canApprove } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

/** Approval requests: approvers see the kinds they approve, everyone sees their own. */
export const GET = route(async (_req, _ctx, me) => ({
  approvals: approvalsFor(me).slice(0, 300),
  canApprove: { backup: canApprove(me, 'backup'), restore: canApprove(me, 'restore') },
}), { perm: 'runs:read' });
