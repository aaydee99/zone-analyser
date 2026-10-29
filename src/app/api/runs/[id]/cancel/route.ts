import { route } from '@/lib/http';
import { cancelRun } from '@/lib/runner';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (_req, { params }, me) => { await cancelRun(me, (await params).id); }, { perm: 'runs:cancel' });
