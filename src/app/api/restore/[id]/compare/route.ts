import { route } from '@/lib/http';
import { compareRestore } from '@/lib/restore';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Compares every resource in the backup with the live zone (terraform import + plan; read-only). */
export const POST = route<Ctx>(async (_req, { params }, me) => compareRestore(me, (await params).id), { perm: 'restore:run' });
