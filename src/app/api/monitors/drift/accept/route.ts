import { HttpError, readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { acceptBaseline } from '@/lib/checks/drift';
import { compactNum } from '@/lib/num';

export const dynamic = 'force-dynamic';

/** Accepts the newest state of one zone ({ zoneId }) or of every zone ({}) as the drift baseline; its changes and drift findings close. */
export const POST = route(async (req, _ctx, me) => {
  const { zoneId } = await readBody<{ zoneId?: string }>(req).catch(() => ({} as { zoneId?: string }));
  if (zoneId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(zoneId)) throw new HttpError(400, 'Unknown zone');
  const accepted = await acceptBaseline(me.email, zoneId);
  if (!accepted.length) throw new HttpError(404, 'Nothing to accept yet — run the drift check first');
  await audit(me, 'monitoring.baseline_accepted', zoneId ? accepted[0].name : `${compactNum(accepted.length)} zones`, { zones: accepted.length });
  return { accepted: accepted.slice(0, 50).map((z) => z.name), count: accepted.length };
}, { perm: 'monitors:manage' });
