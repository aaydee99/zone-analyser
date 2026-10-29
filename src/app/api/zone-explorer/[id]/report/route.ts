import { route } from '@/lib/http';
import { zoneReport } from '@/lib/zone-explorer';
import { auditView, isFresh, zoneIdOf } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Everything about one zone in one answer, built from the cached section endpoints. ?fresh=1 reads every section again. */
export const GET = route<Ctx>(async (req, { params }, me) => {
  const report = await zoneReport(await zoneIdOf(params), isFresh(req));
  await auditView(me, report.zone);
  return report;
}, { perm: 'runs:read', limit: { name: 'zone-report', max: 30 } });
