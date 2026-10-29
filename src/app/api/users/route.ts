import { readBody, route } from '@/lib/http';
import { createUser, listUsers } from '@/lib/users';

export const dynamic = 'force-dynamic';

export const GET = route(async () => ({ users: await listUsers() }), { perm: 'users:manage' });

export const POST = route(async (req, _ctx, me) => (
  { user: await createUser(me, await readBody(req)) }), { perm: 'users:manage' });
