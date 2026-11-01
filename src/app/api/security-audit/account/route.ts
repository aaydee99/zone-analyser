import { HttpError, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { can } from '@/lib/rbac';
import { accountAudit, stopAccountAudit } from '@/lib/zone-audit/run';

export const dynamic = 'force-dynamic';

/** The account audit running now, or the last one ({ account: null } when there is none). */
export const GET = route(async () => ({ account: accountAudit(), generatedAt: new Date().toISOString() }), { perm: 'runs:read' });

/** Stops the running account audit: no further zone starts, the zones being audited finish. Its starter, or a role that cancels runs. */
export const DELETE = route(async (_req, _ctx, me) => {
  const now = accountAudit();
  if (!now || now.state !== 'running') throw new HttpError(409, 'No account audit is running');
  if (now.startedBy !== me.email && !can(me.role, 'runs:cancel')) throw new HttpError(403, 'Only the person who started it, or an operator and up, can stop it');
  const b = stopAccountAudit();
  await audit(me, 'zone_audit.account_stopped', now.accountName, { accountId: now.accountId, done: now.ready + now.failed + now.skipped, total: now.total });
  return { account: b };
}, { perm: 'runs:read' });
