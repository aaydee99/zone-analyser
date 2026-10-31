import { route } from '@/lib/http';
import { zoneSummary } from '@/lib/zone-explorer';
import { auditView, zoneIdOf } from '@/lib/zone-routes';
import { touchRecent } from '@/lib/zone-prefs';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** One zone: its details and the URL of each section and download (any role). No Cloudflare call. */
export const GET = route<Ctx>(async (_req, { params }, me) => {
  const summary = await zoneSummary(await zoneIdOf(params));
  await auditView(me, summary.zone);
  // The user's recent zones: recorded in the background, never delaying the answer.
  touchRecent(me.id, summary.zone);
  return summary;
}, { perm: 'runs:read', limit: { name: 'zone-report', max: 30 } });
