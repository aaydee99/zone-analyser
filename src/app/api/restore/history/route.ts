import { route } from '@/lib/http';
import { liveRestoreIds } from '@/lib/restore';
import { restoreHistory } from '@/lib/restore-history';
import { recordFilter } from '@/lib/record-access';

export const dynamic = 'force-dynamic';

/**
 * The restores this person may see (record-access.ts: their own; admins also operators' and viewers';
 * super admins all), newest first with their outcome, and recent restore activity: for the Restore
 * overview and history.
 */
export const GET = route(async (_req, _ctx, me) => restoreHistory(liveRestoreIds(), await recordFilter(me)), { perm: 'restore:run' });
