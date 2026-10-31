import { HttpError, route } from '@/lib/http';
import { getDefinition, getRun } from '@/lib/report-store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ runId: string }> };

/** One report made, with everything it holds. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const run = await getRun((await params).runId);
  if (!run) throw new HttpError(404, 'Report not found');
  const definition = await getDefinition(run.definitionId);
  return { run, definition, generatedAt: new Date().toISOString() };
}, { perm: 'runs:read' });
