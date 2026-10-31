import { HttpError, readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { BRAND } from '@/lib/brand';
import { cfCall, cfReason, ok, refused } from '@/lib/cf-read';
import { accountTargets } from '@/lib/cf-targets';
import { isAllowedHost, isLoopbackHost } from '@/lib/hosts';
import { inboxSecret } from '@/lib/monitor-config';

export const dynamic = 'force-dynamic';

/**
 * Adds this console as a webhook destination in one Cloudflare account ({ accountId, origin }), so
 * Cloudflare can send its alerts here (POST /api/hooks/cloudflare). `origin` is the address the
 * console is opened at; it must be a public HTTPS host the console serves. Cloudflare sends a test
 * message when the destination is created, so the console must be reachable from the internet.
 * Then pick, in Cloudflare, which notifications go to this destination.
 */
export const POST = route(async (req, _ctx, me) => {
  const { accountId, origin } = await readBody<{ accountId?: string; origin?: string }>(req);
  let u: URL;
  try { u = new URL(String(process.env.CONSOLE_PUBLIC_URL || origin || '')); } catch { throw new HttpError(400, 'The console’s address is missing'); }
  if (u.protocol !== 'https:' || isLoopbackHost(u.host) || !isAllowedHost(u.host)) {
    throw new HttpError(400, 'Cloudflare can only send alerts to the console at a public https:// address it serves — open the console at that address (or set CONSOLE_PUBLIC_URL) and try again');
  }
  const t = (await accountTargets()).accounts.find((a) => a.accountId === accountId);
  if (!t) throw new HttpError(404, 'No stored credential reads that account');
  const secret = await inboxSecret(true);
  const r = await cfCall(t.token, 'POST', `/accounts/${t.accountId}/alerting/v3/destinations/webhooks`, { name: `${BRAND.name} console`, url: `${u.origin}/api/hooks/cloudflare`, secret });
  if (!ok(r)) {
    throw new HttpError(refused(r) ? 403 : 502, refused(r) ? `Cloudflare refused it: the stored token needs “Account › Notifications › Edit” (${cfReason(r)})` : `Cloudflare could not add the destination: ${cfReason(r)}`);
  }
  await audit(me, 'monitoring.inbox_connected', t.accountName || t.accountId, { url: `${u.origin}/api/hooks/cloudflare` });
  return { ok: true, url: `${u.origin}/api/hooks/cloudflare` };
}, { perm: 'restore:approve', limit: { name: 'alerts-connect', max: 10, windowMs: 10 * 60_000 } });
