import { HttpError, route } from '@/lib/http';
import { can } from '@/lib/rbac';
import { listFindings } from '@/lib/monitor-store';
import { CHECKS, SEVERITIES, isCheckId, type FindingsPage, type Severity } from '@/lib/monitor-types';

export const dynamic = 'force-dynamic';

/** Open findings, worst first: ?check=&severity=&dismissed=1&q=&offset=&limit= (up to 200). Only checks the user may see. */
export const GET = route(async (req, _ctx, me) => {
  const u = new URL(req.url).searchParams;
  const check = u.get('check');
  if (check && !isCheckId(check)) throw new HttpError(404, 'Unknown check');
  const checks = CHECKS.filter((c) => can(me.role, c.perm) && (!check || c.id === check)).map((c) => c.id);
  if (check && !checks.length) throw new HttpError(403, 'You cannot see this check');
  const sev = u.get('severity');
  const offset = Math.max(0, Math.floor(Number(u.get('offset')) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(u.get('limit')) || 50)));
  const page = await listFindings({
    checks, severity: SEVERITIES.includes(sev as Severity) ? (sev as Severity) : undefined, dismissed: u.get('dismissed') === '1',
    q: u.get('q') ?? '', offset, limit,
  });
  const out: FindingsPage = { ...page, offset };
  return out;
}, { perm: 'runs:read' });
