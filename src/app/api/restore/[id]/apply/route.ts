import { readBody, route } from '@/lib/http';
import { applyRestore } from '@/lib/restore';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Applies the reviewed plan. Needs the zone name typed back, an explicit OK for replacements, and a Global API Key + email (used for this apply only). */
export const POST = route<Ctx>(async (req, { params }, me) => (
  applyRestore(me, (await params).id, await readBody<{ confirm?: string; acknowledgeReplace?: boolean; email?: string; apiKey?: string }>(req))), { perm: 'restore:run', limit: { name: 'restore-apply', max: 10 } });
