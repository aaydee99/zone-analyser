import { route } from '@/lib/http';
import { rulesetNames } from '@/lib/zone-explorer';
import { isFresh, zoneIdOf } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Names of the rulesets the zone can use (managed ones too), by id. Cached under this path; ?fresh=1 reads again. */
export const GET = route<Ctx>(async (req, { params }) => ({ rulesetNames: await rulesetNames(await zoneIdOf(params), isFresh(req)) }),
  { perm: 'runs:read', limit: { name: 'zone-section', max: 400 } });
