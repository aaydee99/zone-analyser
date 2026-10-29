import { readBody, route } from '@/lib/http';
import { createCredential, listCredentials, type CredentialInput } from '@/lib/vault';

export const dynamic = 'force-dynamic';

export const GET = route(async (_req, _ctx, me) => ({ credentials: await listCredentials(me) }), { perm: 'vault:access' });

export const POST = route(async (req, _ctx, me) => (
  { credential: await createCredential(me, await readBody<CredentialInput>(req)) }), { perm: 'vault:access' });
