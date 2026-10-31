import { HttpError, readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { acceptBaseline } from '@/lib/checks/drift';
import { resolveForZones } from '@/lib/monitor-store';
import { startRun } from '@/lib/monitor-runner';

export const dynamic = 'force-dynamic';

/** Accepts the newest state of one zone ({ zoneId }) or of every zone ({}) as the drift baseline, then checks drift again. */
export const POST = route(async (req, _ctx, me) => {
  const { zoneId } = await readBody<{ zoneId?: string }>(req).catch(() => ({} as { zoneId?: string }));
  if (zoneId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(zoneId)) throw new HttpError(400, 'Unknown zone');
  const accepted = await acceptBaseline(me.email, zoneId);
  if (!accepted.length) throw new HttpError(404, 'Nothing to accept yet — run the drift check first');
  await resolveForZones('drift', accepted.map((z) => z.id));
  await audit(me, 'monitoring.baseline_accepted', zoneId ? accepted[0].name : `${accepted.length} zones`, { zones: accepted.length });
  startRun(['drift'], me, me.email);
  return { accepted: accepted.map((z) => z.name) };
}, { perm: 'monitors:manage' });
