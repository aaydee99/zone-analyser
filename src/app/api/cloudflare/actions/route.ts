import { readBody, route } from '@/lib/http';
import { requestAction } from '@/lib/cf-actions';

export const dynamic = 'force-dynamic';

/**
 * A change in Cloudflare: { type: 'purge', accountId, zoneId, mode, values } or a rollback
 * ({ type: 'worker-rollback', accountId, script, versionId } / { type: 'pages-rollback', accountId, project, deploymentId }).
 * A super admin's runs at once; an admin's waits for a super admin on the Approvals page.
 */
export const POST = route(async (req, _ctx, me) => requestAction(me, await readBody(req)), { perm: 'cloudflare:act', limit: { name: 'cf-actions', max: 20, windowMs: 10 * 60_000 } });
