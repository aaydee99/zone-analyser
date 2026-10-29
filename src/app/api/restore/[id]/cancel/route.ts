import { route } from '@/lib/http';
import { cancelRestore } from '@/lib/restore';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Cancels the restore's running job (compare, plan or apply) and stops terraform with its process tree. */
export const POST = route<Ctx>(async (_req, { params }, me) => cancelRestore(me, (await params).id), { perm: 'restore:run' });
