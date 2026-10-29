import { HttpError, route } from '@/lib/http';
import { liveRestoreIds } from '@/lib/restore';
import { restoreRecord } from '@/lib/restore-history';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** One restore: its steps, the plan it applied (addresses and actions) and its log. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  if (!/^(audit-\d{1,18}|[A-Za-z0-9_-]{8,32})$/.test(id)) throw new HttpError(404, 'Restore not found');
  return restoreRecord(id, liveRestoreIds().has(id));
}, { perm: 'restore:run' });
