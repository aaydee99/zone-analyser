import { HttpError, route } from '@/lib/http';
import { can } from '@/lib/rbac';
import { listFindings } from '@/lib/monitor-store';
import { liteOf, metaOf, zoneIdsMatching } from '@/lib/zone-meta';
import { filterFromParams, type ZoneMetaLite } from '@/lib/zone-meta-types';
import { CHECKS, SEVERITIES, isCheckId, type FindingsPage, type Severity } from '@/lib/monitor-types';

export const dynamic = 'force-dynamic';

/** Open findings, worst first: ?check=&severity=&dismissed=1&q=&tags=&owner=&mq=&offset=&limit= (up to 200). Only checks the user may see. */
export const GET = route(async (req, _ctx, me) => {
  const u = new URL(req.url).searchParams;
  const check = u.get('check');
  if (check && !isCheckId(check)) throw new HttpError(404, 'Unknown check');
  const checks = CHECKS.filter((c) => can(me.role, c.perm) && (!check || c.id === check)).map((c) => c.id);
  if (check && !checks.length) throw new HttpError(403, 'You cannot see this check');
  const sev = u.get('severity');
  const offset = Math.max(0, Math.floor(Number(u.get('offset')) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(u.get('limit')) || 50)));
  // ?tags=&owner=&mq=: only findings of zones with these tags / this owner (resolved in the database).
  const zones = await zoneIdsMatching(filterFromParams(u));
  const page = await listFindings({
    checks, severity: SEVERITIES.includes(sev as Severity) ? (sev as Severity) : undefined, dismissed: u.get('dismissed') === '1',
    q: u.get('q') ?? '', offset, limit, ...(zones ? { zoneIds: [...zones] } : {}),
  });
  // Each zone's tags and owner, to show next to its findings (none when migration 0015 is not applied).
  const ids = [...new Set(page.findings.map((f) => f.zoneId).filter((x): x is string => !!x))];
  const zoneMeta = ids.length ? await metaOf(ids).then(liteOf).catch(() => ({})) : {};
  const out: FindingsPage & { zoneMeta: Record<string, ZoneMetaLite> } = { ...page, offset, zoneMeta };
  return out;
}, { perm: 'runs:read' });
