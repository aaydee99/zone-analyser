import { HttpError, route } from '@/lib/http';
import { ZONE_ID, templateZone } from '@/lib/compare';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; zoneId: string }> };

/** One zone against a template, computed now from its stored configuration. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const { id, zoneId } = await params;
  if (!ZONE_ID.test(zoneId)) throw new HttpError(400, 'Unknown zone');
  return { ...(await templateZone(id, zoneId)), generatedAt: new Date().toISOString() };
}, { perm: 'runs:read' });
