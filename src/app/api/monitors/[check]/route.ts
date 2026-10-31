import { HttpError, requirePerm, route } from '@/lib/http';
import { DEFS } from '@/lib/checks';
import { countRows, countsOf, coverage, coverageOf, openCounts, problems, totals } from '@/lib/monitor-store';
import { CHECK, isCheckId, type CheckView } from '@/lib/monitor-types';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ check: string }> };

/** One check: its stats, its tables (rows come from …/rows), how much was read, and reads that failed. */
export const GET = route<Ctx>(async (_req, { params }, me) => {
  const id = (await params).check;
  if (!isCheckId(id)) throw new HttpError(404, 'Unknown check');
  requirePerm(me, CHECK[id].perm);
  const def = DEFS[id];
  const [sum, cov, open, failed, sizes] = await Promise.all([totals(id), coverage(), openCounts(), problems(id), Promise.all(def.sections.map((s) => countRows(id, s.key)))]);
  const c = coverageOf(cov, id);
  const counts = countsOf(open, id);
  const view: CheckView = {
    meta: CHECK[id],
    stats: def.stats({ counts: sum, open: counts, targets: { total: c.targets, read: c.read, failing: c.failing, never: c.never } }),
    sections: def.sections.map((s, i) => ({ ...s, total: sizes[i] })),
    coverage: c, open: counts, problems: failed, generatedAt: new Date().toISOString(),
  };
  return view;
}, { perm: 'runs:read' });
