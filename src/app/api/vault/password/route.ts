import { readBody, route } from '@/lib/http';
import { changeVaultPassword } from '@/lib/vault';

export const dynamic = 'force-dynamic';

export const POST = route(async (req, _ctx, me) => {
  const { current, next } = await readBody<{ current: string; next: string }>(req);
  await changeVaultPassword(me, current, next);
}, { perm: 'vault:access', limit: { name: 'vault-password', max: 5 } });
