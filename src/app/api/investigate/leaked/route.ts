import { route } from '@/lib/http';
import { backgroundAnswer } from '@/lib/investigate-jobs';
import { leakedReport } from '@/lib/leaked-creds';

export const dynamic = 'force-dynamic';

/**
 * Leaked credentials (read-only): ?zone=ID or ?account=ID[&offset=0&limit=5 (at most 10 zones)]
 * [&hours=24|72|168][&fresh=1]. Any role. Each zone's result is kept 30 minutes. 202 while reading (see ray).
 */
export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  const o = {
    zoneId: q.get('zone') || undefined, accountId: q.get('account') || undefined, hours: q.get('hours') ? Number(q.get('hours')) : undefined,
    offset: Number(q.get('offset')) || 0, limit: q.get('limit') ? Number(q.get('limit')) : undefined, fresh: q.get('fresh') === '1',
  };
  const key = `leaked:${o.zoneId ?? ''}:${o.accountId ?? ''}:${o.hours ?? ''}:${o.offset}:${o.limit ?? ''}:${o.fresh ? 1 : 0}`;
  return backgroundAnswer(key, q.get('job'), (progress) => leakedReport({ ...o, progress }));
}, { perm: 'runs:read', on: 'web', limit: { name: 'investigate-leaked', max: 120 } });
