import { readBody, route } from '@/lib/http';
import { planRestore } from '@/lib/restore';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Writes a Terraform dir with only the chosen blocks and starts init + plan. */
export const POST = route<Ctx>(async (req, { params }, me) => {
  const { addresses } = await readBody<{ addresses: string[] }>(req);
  return planRestore(me, (await params).id, addresses);
}, { perm: 'restore:run' });
