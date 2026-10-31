import { HttpError, route } from '@/lib/http';
import { backgroundAnswer } from '@/lib/investigate-jobs';
import { zoneTimeline } from '@/lib/zone-timeline';

export const dynamic = 'force-dynamic';

/** One zone's incident timeline: ?zone=ID[&hours=6|24|72|168][&fresh=1]. Any role. Kept five minutes. 202 while reading (see ray). */
export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  const zone = q.get('zone') ?? '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(zone)) throw new HttpError(400, 'Choose a zone');
  const hours = Number(q.get('hours')) || 24;
  const fresh = q.get('fresh') === '1';
  return backgroundAnswer(`timeline:${zone}:${hours}:${fresh ? 1 : 0}`, q.get('job'), (progress) => zoneTimeline(zone, hours, fresh, progress));
}, { perm: 'runs:read', limit: { name: 'investigate-timeline', max: 120 } });
