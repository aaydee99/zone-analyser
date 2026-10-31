import { HttpError, route } from '@/lib/http';
import { listJobs } from '@/lib/logpush';
import { LOGPUSH_STATUSES, type LogpushStatus } from '@/lib/logpush-types';

export const dynamic = 'force-dynamic';

/** One page of Logpush jobs, from monitoring's stored list: ?status=&scope=account|zone&q=&offset=&limit= (up to 200). */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const status = u.get('status') || undefined;
  if (status && !LOGPUSH_STATUSES.includes(status as LogpushStatus)) throw new HttpError(400, 'Unknown status');
  const scope = u.get('scope') || undefined;
  if (scope && scope !== 'account' && scope !== 'zone') throw new HttpError(400, 'scope must be account or zone');
  return listJobs({
    status: status as LogpushStatus | undefined, scope: scope as 'account' | 'zone' | undefined, q: u.get('q') ?? '',
    offset: Math.max(0, Math.floor(Number(u.get('offset')) || 0)), limit: Math.min(200, Math.max(1, Math.floor(Number(u.get('limit')) || 50))),
  });
}, { perm: 'runs:read' });
