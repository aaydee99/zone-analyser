import { readBody, route } from '@/lib/http';
import { revealField } from '@/lib/vault';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Returns one field in plaintext — POST so it is never cached or prefetched. Audited. */
export const POST = route<Ctx>(async (req, { params }, me) => {
  const { field } = await readBody<{ field: string }>(req);
  return { value: await revealField(me, (await params).id, field) };
}, { perm: 'vault:access', limit: { name: 'reveal', max: 20 } });
