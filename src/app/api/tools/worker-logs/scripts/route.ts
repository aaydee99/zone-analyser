import { route } from '@/lib/http';
import { accountScripts } from '@/lib/worker-tail';

export const dynamic = 'force-dynamic';

/** An account's Workers: ?accountId= (monitoring's stored list), &fresh=1 to read Cloudflare. */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  return accountScripts(u.get('accountId') ?? '', u.get('fresh') === '1');
}, { perm: 'workers:tail' });
