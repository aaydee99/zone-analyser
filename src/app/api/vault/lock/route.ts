import { route } from '@/lib/http';
import { lockVault } from '@/lib/vault';

export const dynamic = 'force-dynamic';

export const POST = route(async (_req, _ctx, me) => { await lockVault(me); }, { perm: 'vault:access' });
