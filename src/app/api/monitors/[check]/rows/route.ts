import { HttpError, requirePerm, route } from '@/lib/http';
import { DEFS } from '@/lib/checks';
import { listRows } from '@/lib/monitor-store';
import { CHECK, isCheckId, type RowsPage } from '@/lib/monitor-types';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ check: string }> };

/** One page of a check's table: ?section=&offset=&limit= (up to 200)&q= (search). */
export const GET = route<Ctx>(async (req, { params }, me) => {
  const id = (await params).check;
  if (!isCheckId(id)) throw new HttpError(404, 'Unknown check');
  requirePerm(me, CHECK[id].perm);
  const u = new URL(req.url).searchParams;
  const section = u.get('section') ?? '';
  if (!DEFS[id].sections.some((s) => s.key === section)) throw new HttpError(404, 'Unknown table');
  const offset = Math.max(0, Math.floor(Number(u.get('offset')) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(u.get('limit')) || 50)));
  const page: RowsPage = { ...(await listRows(id, section, { offset, limit, q: u.get('q') ?? '' })), offset };
  return page;
}, { perm: 'runs:read' });
