import { readBody, route } from '@/lib/http';
import { deleteCredential, updateCredential, type CredentialInput } from '@/lib/vault';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const PUT = route<Ctx>(async (req, { params }, me) => (
  { credential: await updateCredential(me, (await params).id, await readBody<CredentialInput>(req)) }), { perm: 'vault:access' });

export const DELETE = route<Ctx>(async (_req, { params }, me) => { await deleteCredential(me, (await params).id); }, { perm: 'vault:access' });
