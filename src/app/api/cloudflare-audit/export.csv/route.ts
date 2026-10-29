import { HttpError, route } from '@/lib/http';
import { cachedActivity } from '@/lib/cf-audit-cache';
import { CATEGORIES, filterChanges, toCsv, type CategoryKey } from '@/lib/cf-audit-report';
import { audit } from '@/lib/audit';
import { attachment } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';

/** The CSV download: the same query as /api/cloudflare-audit, plus the page's &q= search and &category= (from the cached report). */
export const GET = route(async (req, _ctx, me) => {
  const url = new URL(req.url);
  const category = url.searchParams.get('category') ?? '';
  if (category && !CATEGORIES.some((c) => c.key === category)) throw new HttpError(400, 'Unknown category');
  const report = await cachedActivity(url);
  const changes = filterChanges(report.changes, (url.searchParams.get('q') ?? '').slice(0, 200), category as CategoryKey | '');
  await audit(me, 'cloudflare_audit.exported', null, { range: report.range, since: report.since, before: report.before, changes: changes.length });
  return attachment(`cloudflare-changes-${report.since.slice(0, 10)}-to-${report.before.slice(0, 10)}.csv`, toCsv(changes), 'text/csv; charset=utf-8');
}, { perm: 'audit:read', limit: { name: 'cf-export', max: 20 } });
