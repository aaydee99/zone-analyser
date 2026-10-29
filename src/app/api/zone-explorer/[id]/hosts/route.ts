import { route } from '@/lib/http';
import { zoneReport } from '@/lib/zone-explorer';
import { rulesByHost } from '@/lib/zone-format';
import { isFresh, zoneIdOf } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Every rule grouped by the hostnames it runs on (whole zone, the apex, each other hostname), from the cached sections. ?fresh=1 reads them again. */
export const GET = route<Ctx>(async (req, { params }) => {
  const r = await zoneReport(await zoneIdOf(params), isFresh(req));
  return {
    zoneId: r.zone.id, generatedAt: r.generatedAt, ...(r.cachedIn ? { cachedIn: r.cachedIn } : {}),
    ...rulesByHost(r.zone.name, r.rules, r.sections, r.rulesetNames),
  };
}, { perm: 'runs:read', limit: { name: 'zone-report', max: 30 } });
