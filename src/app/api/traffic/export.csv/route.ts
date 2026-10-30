import { HttpError, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { trafficCsv, trafficMonths, trafficReport } from '@/lib/traffic';
import { attachment } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';

/** The chosen account's (or zone's) month as CSV, one row per zone (from the cached month). */
export const GET = route(async (req, _ctx, me) => {
  const q = new URL(req.url).searchParams;
  const month = q.get('month') || trafficMonths()[0];
  const report = await trafficReport(month, q.get('account') ?? '', q.get('zone') || undefined);
  if ('pending' in report) throw new HttpError(409, 'This month is still being read from Cloudflare — download it once the page shows it');
  const { scope } = report;
  await audit(me, 'traffic.exported', scope.zoneName ?? scope.accountName, { month, accountId: scope.accountId, zoneId: scope.zoneId ?? null, format: 'csv', zones: report.zones.length });
  const name = (scope.zoneName ?? scope.accountName).replace(/[^A-Za-z0-9._-]+/g, '-');
  return attachment(`cloudflare-traffic-${name}-${month}.csv`, trafficCsv(report), 'text/csv; charset=utf-8');
}, { perm: 'runs:read', limit: { name: 'traffic-export', max: 20 } });
