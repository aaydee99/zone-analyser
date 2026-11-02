import { HttpError, route } from '@/lib/http';
import { deleteRun, getRun, readIntegritySummary } from '@/lib/runner';
import { listApprovals } from '@/lib/approvals-store';
import { mustSeeRun } from '@/lib/record-access';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }, me) => {
  const run = await getRun((await params).id);
  if (!run) throw new HttpError(404, 'Run not found');
  await mustSeeRun(me, run);
  // Started from an operator's request: who asked and who approved.
  const a = listApprovals().find((x) => x.runId === run.id);
  const approval = a ? { id: a.id, requestedBy: a.requestedBy.email, requestedAt: a.requestedAt, approvedBy: a.decidedBy?.email ?? '', approvedAt: a.decidedAt ?? '' } : null;
  return { run, approval, integrity: run.status === 'running' ? null : readIntegritySummary(run) };
}, { perm: 'runs:read' });

export const DELETE = route<Ctx>(async (_req, { params }, me) => {
  const id = (await params).id;
  const run = await getRun(id);
  if (run) await mustSeeRun(me, run);
  await deleteRun(me, id);
}, { perm: 'runs:delete' });
