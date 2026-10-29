import { readBody, route } from '@/lib/http';
import { unlockVault } from '@/lib/vault';

export const dynamic = 'force-dynamic';

export const POST = route(async (req, _ctx, me) => {
  const { password } = await readBody<{ password: string }>(req);
  await unlockVault(me, password);
}, { perm: 'vault:access', limit: { name: 'vault-unlock', max: 10 } });
