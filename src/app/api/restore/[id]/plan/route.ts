import { readBody, route } from '@/lib/http';
import { planRestore } from '@/lib/restore';
import { mustSeeRestore } from '@/lib/record-access';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Writes a Terraform dir with only the chosen blocks and starts init + plan. */
export const POST = route<Ctx>(async (req, { params }, me) => {
  const { id } = await params;
  await mustSeeRestore(me, id);
  const { addresses } = await readBody<{ addresses: string[] }>(req);
  return planRestore(me, id, addresses);
}, { perm: 'restore:run' });
