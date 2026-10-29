import { readBody, route } from '@/lib/http';
import { prepareRestore, type PrepareInput } from '@/lib/restore';

export const dynamic = 'force-dynamic';

/** Finds the newest backup of the zone, reads the audit log since it and lists what can be restored. */
export const POST = route(async (req, _ctx, me) => prepareRestore(me, await readBody<PrepareInput>(req)), { perm: 'restore:run' });
