import { route } from '@/lib/http';
import { deletePreset } from '@/lib/presets';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const DELETE = route<Ctx>(async (_req, { params }, me) => { await deletePreset(me, (await params).id); }, { perm: 'presets:write' });
