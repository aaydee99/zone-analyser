import { route } from '@/lib/http';
import { trafficMonths, trafficReport } from '@/lib/traffic';
import { isFresh } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';

/** One month of traffic (?month=YYYY-MM, this month by default) for everything, per account and per zone (any role). */
export const GET = route(async (req) => {
  const month = new URL(req.url).searchParams.get('month') || trafficMonths()[0];
  return trafficReport(month, isFresh(req));
}, { perm: 'runs:read', limit: { name: 'traffic', max: 30 } });
