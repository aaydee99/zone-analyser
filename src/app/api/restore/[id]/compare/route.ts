import { route } from '@/lib/http';
import { compareRestore } from '@/lib/restore';
import { mustSeeRestore } from '@/lib/record-access';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Compares every resource in the backup with the live zone (terraform import + plan; read-only). */
export const POST = route<Ctx>(async (_req, { params }, me) => {
  const { id } = await params;
  await mustSeeRestore(me, id);
  return compareRestore(me, id);
}, { perm: 'restore:run' });
