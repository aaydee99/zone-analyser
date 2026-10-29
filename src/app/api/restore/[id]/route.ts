import { route } from '@/lib/http';
import { getRestore } from '@/lib/restore';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => getRestore((await params).id), { perm: 'restore:run' });
