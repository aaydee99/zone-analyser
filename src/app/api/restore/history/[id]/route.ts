import { HttpError, route } from '@/lib/http';
import { liveRestoreIds } from '@/lib/restore';
import { restoreRecord } from '@/lib/restore-history';
import { mustSee, restoreOwners } from '@/lib/record-access';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** One restore: its steps, the plan it applied (addresses and actions) and its log. */
export const GET = route<Ctx>(async (_req, { params }, me) => {
  const { id } = await params;
  if (!/^(audit-\d{1,18}|[A-Za-z0-9_-]{8,32})$/.test(id)) throw new HttpError(404, 'Restore not found');
  const r = await restoreRecord(id, liveRestoreIds().has(id));
  await mustSee(me, restoreOwners(r), 'Restore');
  return r;
}, { perm: 'restore:run' });
