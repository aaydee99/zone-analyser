import { HttpError, requirePerm, route } from '@/lib/http';
import { listFindings, readReport } from '@/lib/monitor-store';
import { runState } from '@/lib/monitor-runner';
import { CHECK, isCheckId, type CheckView } from '@/lib/monitor-types';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ check: string }> };

/** One check: its newest report, its open findings, and whether it is running now. */
export const GET = route<Ctx>(async (_req, { params }, me) => {
  const id = (await params).check;
  if (!isCheckId(id)) throw new HttpError(404, 'Unknown check');
  requirePerm(me, CHECK[id].perm);
  const [stored, findings] = await Promise.all([readReport(id), listFindings({ check: id })]);
  const view: CheckView & { run: ReturnType<typeof runState> } = { meta: CHECK[id], report: stored.report, ranAt: stored.ranAt, error: stored.error, findings, run: runState() };
  return view;
}, { perm: 'runs:read' });
