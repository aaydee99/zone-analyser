import { readBody, route } from '@/lib/http';
import { requestAction } from '@/lib/cf-actions';

export const dynamic = 'force-dynamic';
/** A cache purge may list up to 10,000 URLs (sent to Cloudflare 100 at a time): up to 2 MB. */
const ACTION_BODY = 2 * 1024 * 1024;

/**
 * A change in Cloudflare: { type: 'purge', accountId, zoneId, mode, values } or a rollback
 * ({ type: 'worker-rollback', accountId, script, versionId } / { type: 'pages-rollback', accountId, project, deploymentId }).
 * A super admin's runs at once; an admin's waits for a super admin on the Approvals page.
 */
export const POST = route(async (req, _ctx, me) => requestAction(me, await readBody(req, ACTION_BODY)), { perm: 'cloudflare:act', limit: { name: 'cf-actions', max: 20, windowMs: 10 * 60_000 } });
