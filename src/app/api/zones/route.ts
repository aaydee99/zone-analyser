import { HttpError, route } from '@/lib/http';
import { credentialForRun } from '@/lib/vault';
import { listZones, tokenAccounts } from '@/lib/providers';

export const dynamic = 'force-dynamic';

/**
 * Lists zones with a stored token — decrypted on the server only; the token never reaches the browser.
 * Also the set's accounts (with how many zones each has), so a set without an account ID can be
 * narrowed to one account; `allAccounts` says the set covers every account its token can access.
 */
export const GET = route(async (req) => {
  const id = new URL(req.url).searchParams.get('credentialId') ?? '';
  const c = await credentialForRun(id, 'cloudflare');
  try {
    const [zones, reachable] = await Promise.all([listZones(c), tokenAccounts(c)]);
    const count = new Map<string, number>();
    for (const z of zones) count.set(z.accountId, (count.get(z.accountId) ?? 0) + 1);
    const accounts = reachable.map((a) => ({
      id: a.id,
      name: a.name || zones.find((z) => z.accountId === a.id)?.accountName || a.id,
      zones: count.get(a.id) ?? 0,
    })).sort((a, b) => a.name.localeCompare(b.name));
    return { zones, accounts, allAccounts: !c.fields.accountId };
  } catch (err) {
    // listZones raises readable messages (Cloudflare's own error text); network faults are summarised.
    const msg = err instanceof Error ? err.message : '';
    if (!msg || msg.includes('fetch failed')) console.error('[zones]', err);
    throw new HttpError(502, !msg || msg.includes('fetch failed') ? 'Could not reach the Cloudflare API' : msg);
  }
}, { perm: 'runs:start' });
