import { HttpError, route } from '@/lib/http';
import { deleteRun, getRun, readIntegritySummary } from '@/lib/runner';
import { listApprovals } from '@/lib/approvals-store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const run = await getRun((await params).id);
  if (!run) throw new HttpError(404, 'Run not found');
  // Started from an operator's request: who asked and who approved.
  const a = listApprovals().find((x) => x.runId === run.id);
  const approval = a ? { id: a.id, requestedBy: a.requestedBy.email, requestedAt: a.requestedAt, approvedBy: a.decidedBy?.email ?? '', approvedAt: a.decidedAt ?? '' } : null;
  return { run, approval, integrity: run.status === 'running' ? null : readIntegritySummary(run) };
}, { perm: 'runs:read' });

export const DELETE = route<Ctx>(async (_req, { params }, me) => { await deleteRun(me, (await params).id); }, { perm: 'runs:delete' });
