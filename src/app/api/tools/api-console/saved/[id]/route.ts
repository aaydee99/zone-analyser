import { route } from '@/lib/http';
import { deleteSaved } from '@/lib/api-console';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const DELETE = route<Ctx>(async (_req, { params }, me) => {
  await deleteSaved(me, (await params).id);
  return { ok: true };
}, { perm: 'cloudflare:query' });
