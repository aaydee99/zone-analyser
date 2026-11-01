import { route } from '@/lib/http';
import { pollTail } from '@/lib/worker-tail';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Events after ?after= (a sequence number) and the session's state. The page asks only while it is visible. */
export const GET = route<Ctx>(async (req, { params }, me) => {
  const after = Math.max(0, Math.floor(Number(new URL(req.url).searchParams.get('after')) || 0));
  return pollTail(me, (await params).id, after);
}, { perm: 'workers:tail' });
