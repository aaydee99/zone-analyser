import { HttpError, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { isDays, readsReport } from '@/lib/cf-insights';

export const dynamic = 'force-dynamic';

/** Who read the configuration of one account (Audit Logs v2 view events): ?accountId=&days=1|7|30[&fresh=1]. */
export const GET = route(async (req, _ctx, me) => {
  const q = new URL(req.url).searchParams;
  const accountId = q.get('accountId') ?? '';
  const days = Number(q.get('days') ?? 7);
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new HttpError(400, 'Choose an account');
  if (!isDays(days)) throw new HttpError(400, 'days must be 1, 7 or 30');
  const report = await readsReport(accountId, days, q.get('fresh') === '1');
  await audit(me, 'cloudflare_audit.reads_viewed', accountId, { days, readers: report.readers.length });
  return report;
}, { perm: 'activity:read' });
