import { HttpError, readBody, route } from '@/lib/http';
import { attachStorage } from '@/lib/vault';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Moves a legacy R2 / AWS credential into this account set (secrets copied server side, never shown). */
export const POST = route<Ctx>(async (req, { params }, me) => {
  const { from, removeSource } = await readBody<{ from?: string; removeSource?: boolean }>(req);
  if (typeof from !== 'string' || !from) throw new HttpError(400, 'Choose the R2 or AWS credential to move into this account set');
  return { credential: await attachStorage(me, (await params).id, from, removeSource === true) };
}, { perm: 'vault:access' });
