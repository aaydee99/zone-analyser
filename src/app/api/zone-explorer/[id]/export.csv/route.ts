import { route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { zoneReport } from '@/lib/zone-explorer';
import { csvFile, reportRows } from '@/lib/zone-format';
import { attachment, zoneIdOf } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** "All as CSV": every section, setting and rule, one row per value (from the cached sections). */
export const GET = route<Ctx>(async (_req, { params }, me) => {
  const report = await zoneReport(await zoneIdOf(params));
  await audit(me, 'cloudflare_zone.exported', report.zone.name, { zoneId: report.zone.id, format: 'csv' });
  return attachment(`${report.zone.name}-${report.generatedAt.slice(0, 10)}-cloudflare.csv`, csvFile(reportRows(report)), 'text/csv; charset=utf-8');
}, { perm: 'runs:read', limit: { name: 'zone-export', max: 20 } });
