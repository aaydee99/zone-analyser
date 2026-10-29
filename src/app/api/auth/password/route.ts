import { readBody, route } from '@/lib/http';
import { changeOwnPassword } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const POST = route(async (req, _ctx, me) => {
  const { current, next } = await readBody<{ current: string; next: string }>(req);
  await changeOwnPassword(me, current, next);
});
