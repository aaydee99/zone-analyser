import { route } from '@/lib/http';
import { vaultStatus } from '@/lib/vault';

export const dynamic = 'force-dynamic';

export const GET = route(async (_req, _ctx, me) => vaultStatus(me), { perm: 'vault:access' });
