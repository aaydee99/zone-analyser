import { route } from '@/lib/http';
import { liveRestoreIds } from '@/lib/restore';
import { restoreHistory } from '@/lib/restore-history';

export const dynamic = 'force-dynamic';

/** Every restore (newest first) with its outcome, and recent restore activity: for the Restore overview and history. */
export const GET = route(async () => restoreHistory(liveRestoreIds()), { perm: 'restore:run' });
