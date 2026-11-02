import { route } from '@/lib/http';
import { cancelRestore } from '@/lib/restore';
import { mustSeeRestore } from '@/lib/record-access';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Cancels the restore's running job (compare, plan or apply) and stops terraform with its process tree. */
export const POST = route<Ctx>(async (_req, { params }, me) => {
  const { id } = await params;
  await mustSeeRestore(me, id);
  return cancelRestore(me, id);
}, { perm: 'restore:run' });
