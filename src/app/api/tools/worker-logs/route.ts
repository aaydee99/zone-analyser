import { route } from '@/lib/http';
import { accountTargets } from '@/lib/cf-targets';
import { currentTail } from '@/lib/worker-tail';

export const dynamic = 'force-dynamic';

/** The accounts to pick a Worker from (names only), and this user's session still running, if any. */
export const GET = route(async (_req, _ctx, me) => {
  const [{ accounts }, current] = await Promise.all([accountTargets(), currentTail(me)]);
  return { accounts: accounts.map((a) => ({ id: a.accountId, name: a.accountName || a.accountId })), current };
}, { perm: 'cloudflare:query' });
