import { HttpError, route } from '@/lib/http';
import { dnsReport, isDays } from '@/lib/cf-insights';

export const dynamic = 'force-dynamic';

/** DNS analytics for one zone: ?zoneId=&days=1|7|30[&fresh=1]. */
export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  const zoneId = q.get('zoneId') ?? '';
  const days = Number(q.get('days') ?? 7);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(zoneId)) throw new HttpError(400, 'Choose a zone');
  if (!isDays(days)) throw new HttpError(400, 'days must be 1, 7 or 30');
  return dnsReport(zoneId, days, q.get('fresh') === '1');
}, { perm: 'runs:read' });
