import { route } from '@/lib/http';
import { deleteView } from '@/lib/zone-prefs';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Deletes one of the signed-in user's saved views. */
export const DELETE = route<Ctx>(async (_req, { params }, me) => {
  await deleteView(me.id, (await params).id);
  return { ok: true };
}, { perm: 'runs:read' });
