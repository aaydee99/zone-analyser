import { route } from '@/lib/http';
import { PERMISSIONS } from '@/lib/rbac';
import { activeRunId } from '@/lib/runner';
import { activeRestore } from '@/lib/job-lock';
import { pendingFor } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

/** The signed-in user, their permissions and the active run. `?peek=1` does not count as activity. */
export const GET = route(async (_req, _ctx, me) => ({
  user: { id: me.id, email: me.email, name: me.name, role: me.role },
  permissions: [...PERMISSIONS[me.role]],
  expiresAt: me.expiresAt,
  activeRunId: activeRunId(),
  activeRestore: activeRestore(),
  /** Requests waiting for this person to approve or reject. */
  pendingApprovals: pendingFor(me),
}));
