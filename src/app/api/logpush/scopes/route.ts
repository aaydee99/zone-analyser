import { route } from '@/lib/http';
import { accountTargets } from '@/lib/cf-targets';
import { listZones } from '@/lib/zone-explorer';

export const dynamic = 'force-dynamic';

/** Where a new job can go: every account (names only), and zones by name: ?q= (50 at most). */
export const GET = route(async (req) => {
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 100);
  const [{ accounts }, list] = await Promise.all([accountTargets(), listZones()]);
  const zones = list.zones.filter((z) => !q || z.name.includes(q)).slice(0, 50).map((z) => ({ id: z.id, name: z.name, accountName: z.accountName }));
  return { accounts: accounts.map((a) => ({ id: a.accountId, name: a.accountName || a.accountId })), zones };
}, { perm: 'cloudflare:act' });
