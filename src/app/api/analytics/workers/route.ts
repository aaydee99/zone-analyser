import { HttpError, route } from '@/lib/http';
import { isDays, workersReport } from '@/lib/cf-insights';

export const dynamic = 'force-dynamic';

/** Workers analytics for one account: ?accountId=&days=1|7|30[&fresh=1]. */
export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  const accountId = q.get('accountId') ?? '';
  const days = Number(q.get('days') ?? 7);
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new HttpError(400, 'Choose an account');
  if (!isDays(days)) throw new HttpError(400, 'days must be 1, 7 or 30');
  return workersReport(accountId, days, q.get('fresh') === '1');
}, { perm: 'runs:read' });
