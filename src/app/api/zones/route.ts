import { HttpError, route } from '@/lib/http';
import { credentialForRun } from '@/lib/vault';
import { listZones } from '@/lib/providers';

export const dynamic = 'force-dynamic';

/** Lists zones with a stored token — decrypted on the server only; the token never reaches the browser. */
export const GET = route(async (req) => {
  const id = new URL(req.url).searchParams.get('credentialId') ?? '';
  const c = await credentialForRun(id, 'cloudflare');
  try {
    return { zones: await listZones(c) };
  } catch (err) {
    // listZones raises readable messages (Cloudflare's own error text); network faults are summarised.
    const msg = err instanceof Error ? err.message : '';
    if (!msg || msg.includes('fetch failed')) console.error('[zones]', err);
    throw new HttpError(502, !msg || msg.includes('fetch failed') ? 'Could not reach the Cloudflare API' : msg);
  }
}, { perm: 'runs:start' });
