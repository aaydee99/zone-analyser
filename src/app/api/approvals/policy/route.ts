import { route } from '@/lib/http';
import { getSettings } from '@/lib/settings';
import { MAX_REASON, MAX_TICKET } from '@/lib/change-note';

export const dynamic = 'force-dynamic';

/** What an approval request must say: whether a reason is required (Settings), and the length limits. */
export const GET = route(async () => ({ requireReason: (await getSettings()).requireReason, maxReason: MAX_REASON, maxTicket: MAX_TICKET }), { perm: 'runs:read' });
