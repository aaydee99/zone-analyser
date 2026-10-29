import { route } from '@/lib/http';
import { PERMISSIONS } from '@/lib/rbac';
import { liveState } from '@/lib/live-state';

export const dynamic = 'force-dynamic';

/** The signed-in user, their permissions and the active run. `?peek=1` does not count as activity. */
export const GET = route(async (_req, _ctx, me) => ({
  user: { id: me.id, email: me.email, name: me.name, role: me.role },
  permissions: [...PERMISSIONS[me.role]],
  expiresAt: me.expiresAt,
  /** The active run and restore, and the requests waiting for this person to approve or reject. */
  ...(await liveState(me)),
}));
