import { route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { zoneReport } from '@/lib/zone-explorer';
import { orderedReport } from '@/lib/zone-format';
import { attachment, zoneIdOf } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** The JSON download: the whole zone in the explorer's section order (from the cached sections). */
export const GET = route<Ctx>(async (_req, { params }, me) => {
  const report = await zoneReport(await zoneIdOf(params));
  await audit(me, 'cloudflare_zone.exported', report.zone.name, { zoneId: report.zone.id, format: 'json' });
  return attachment(`${report.zone.name}-${report.generatedAt.slice(0, 10)}-cloudflare.json`, JSON.stringify(orderedReport(report), null, 2), 'application/json');
}, { perm: 'runs:read', limit: { name: 'zone-export', max: 20 } });
