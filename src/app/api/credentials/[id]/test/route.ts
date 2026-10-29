import { route } from '@/lib/http';
import { getCredential, recordTest } from '@/lib/vault';
import { testCredential } from '@/lib/providers';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (_req, { params }, me) => {
  const c = await getCredential(me, (await params).id);
  const result = await testCredential(c);
  await recordTest(c.id, result);
  await audit(me, 'credential.tested', c.name, { ok: result.ok });
  return { result };
}, { perm: 'vault:access', limit: { name: 'cred-test', max: 20 } });
