import { readBody, route } from '@/lib/http';
import { deleteUser, updateUser } from '@/lib/users';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, { params }, me) => (
  { user: await updateUser(me, (await params).id, await readBody(req)) }), { perm: 'users:manage' });

export const DELETE = route<Ctx>(async (_req, { params }, me) => { await deleteUser(me, (await params).id); }, { perm: 'users:manage' });
