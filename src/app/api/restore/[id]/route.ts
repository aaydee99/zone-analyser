import { route } from '@/lib/http';
import { mustSeeRestore } from '@/lib/record-access';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }, me) => mustSeeRestore(me, (await params).id), { perm: 'restore:run' });
