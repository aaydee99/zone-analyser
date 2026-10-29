import { readBody, route } from '@/lib/http';
import { initVault } from '@/lib/vault';

export const dynamic = 'force-dynamic';

export const POST = route(async (req, _ctx, me) => {
  const { password } = await readBody<{ password: string }>(req);
  await initVault(me, password);
}, { perm: 'vault:access' });
