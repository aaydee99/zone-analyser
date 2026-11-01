import { route } from '@/lib/http';
import { listZones } from '@/lib/zone-explorer';

export const dynamic = 'force-dynamic';

/**
 * Zones and accounts for the investigation pages' pickers, from the cached zone list (no Cloudflare
 * call): ?q= matches zone or account names (and zone IDs), a page at a time (&offset, &limit: 50, at most 200);
 * &account=ID keeps that account's zones only.
 * &accounts=1 adds the accounts (one row each, with their zone count).
 */
export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  const term = (q.get('q') ?? '').trim().toLowerCase().slice(0, 100);
  const offset = Math.max(0, Number(q.get('offset')) || 0);
  const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50));
  const list = await listZones();
  const readable = list.zones.filter((z) => list.credentialOf[z.id]);
  const account = q.get('account') ?? '';
  const inAccount = account ? readable.filter((z) => z.accountId === account) : readable;
  const hits = term ? inAccount.filter((z) => z.name.toLowerCase().includes(term) || z.id === term || z.accountName.toLowerCase().includes(term)) : inAccount;
  // Exact and leading matches first, then the rest by name.
  const rank = (n: string) => (n === term ? 0 : n.startsWith(term) ? 1 : 2);
  const sorted = term ? [...hits].sort((a, b) => rank(a.name.toLowerCase()) - rank(b.name.toLowerCase()) || a.name.localeCompare(b.name)) : hits;
  let accounts: { id: string; name: string; zones: number }[] | undefined;
  if (q.get('accounts') === '1') {
    const m = new Map<string, { id: string; name: string; zones: number }>();
    for (const z of readable) {
      const a = m.get(z.accountId) ?? { id: z.accountId, name: z.accountName || z.accountId, zones: 0 };
      a.zones++;
      m.set(z.accountId, a);
    }
    accounts = [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  return {
    zones: sorted.slice(offset, offset + limit).map((z) => ({ id: z.id, name: z.name, accountId: z.accountId, accountName: z.accountName, plan: z.plan, status: z.status })),
    total: sorted.length, offset, limit, ...(accounts ? { accounts } : {}), listedAt: new Date(list.at).toISOString(),
  };
}, { perm: 'runs:read' });
