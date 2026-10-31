import { HttpError, route } from '@/lib/http';
import { pendingZones, watchZone } from '@/lib/onboarding';
import type { PendingView } from '@/lib/onboarding-types';

export const dynamic = 'force-dynamic';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * ?zone=<id>: the zone's status and nameservers now (one Cloudflare call and one public DNS lookup).
 * Without it: the zones not active yet, as the DNS hygiene check last saw them (?account=&offset=&limit=, no Cloudflare call).
 */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const zone = u.get('zone');
  if (zone) {
    if (!ID.test(zone)) throw new HttpError(400, 'Unknown zone');
    return watchZone(zone);
  }
  const account = u.get('account') || undefined;
  if (account && !ID.test(account)) throw new HttpError(400, 'Unknown account');
  const offset = Math.max(0, Math.floor(Number(u.get('offset')) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(u.get('limit')) || 50)));
  const view: PendingView = { ...(await pendingZones({ offset, limit, account })), offset, generatedAt: new Date().toISOString() };
  return view;
}, { perm: 'runs:read', limit: { name: 'onboarding-watch', max: 120, windowMs: 5 * 60_000 } });
