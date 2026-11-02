import { route } from '@/lib/http';
import { cancelRun, getRun } from '@/lib/runner';
import { mustSeeRun } from '@/lib/record-access';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (_req, { params }, me) => {
  const id = (await params).id;
  const run = await getRun(id);
  if (run) await mustSeeRun(me, run);
  await cancelRun(me, id);
}, { perm: 'runs:cancel' });
