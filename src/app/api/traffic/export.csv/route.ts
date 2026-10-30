import { route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { trafficCsv, trafficMonths, trafficReport } from '@/lib/traffic';
import { attachment } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';

/** The month as CSV, one row per zone (from the cached month). */
export const GET = route(async (req, _ctx, me) => {
  const month = new URL(req.url).searchParams.get('month') || trafficMonths()[0];
  const report = await trafficReport(month);
  await audit(me, 'traffic.exported', month, { format: 'csv', zones: report.accounts.reduce((n, a) => n + a.zones.length, 0) });
  return attachment(`cloudflare-traffic-${month}.csv`, trafficCsv(report), 'text/csv; charset=utf-8');
}, { perm: 'runs:read', limit: { name: 'traffic-export', max: 20 } });
