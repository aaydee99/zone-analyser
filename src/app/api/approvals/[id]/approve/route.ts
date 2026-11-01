import { readBody, route } from '@/lib/http';
import { decide } from '@/lib/approvals';
import { parseRuntimeCredential, withRuntimeCredential } from '@/lib/cf-runtime-credential';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/**
 * Approves a pending request and starts it at once (a backup run, a restore apply, a Cloudflare
 * change). `cloudflare` in the body: the API token or Global API Key a Logpush change runs with,
 * typed in by the approver; used for this request only, never stored or returned.
 */
export const POST = route<Ctx>(async (req, { params }, me) => {
  const body = await readBody<{ cloudflare?: unknown }>(req).catch(() => ({} as { cloudflare?: unknown }));
  const cred = parseRuntimeCredential(body?.cloudflare);
  const id = (await params).id;
  return { approval: await withRuntimeCredential(cred, () => decide(me, id, 'approve')) };
}, { perm: 'runs:read', limit: { name: 'approval-decide', max: 30 } });
