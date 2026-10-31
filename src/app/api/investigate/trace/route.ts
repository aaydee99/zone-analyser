import { audit } from '@/lib/audit';
import { readBody, route } from '@/lib/http';
import { traceRequest, type TraceInput } from '@/lib/request-trace';

export const dynamic = 'force-dynamic';

/**
 * Traces a made-up request through the zone's rules with Cloudflare's request tracer (which changes
 * nothing; the stored token needs "Account › Request Tracer › Read"). Any role. The traced request is
 * never sent on to the origin. Recorded in the audit log (method and URL without its query — never headers or cookies).
 */
export const POST = route(async (req, _ctx, me) => {
  const r = await traceRequest(await readBody<TraceInput>(req));
  await audit(me, 'cloudflare.request_traced', r.zoneName, { method: r.method, url: r.url.split('?')[0], status: r.statusCode });
  return r;
}, { perm: 'runs:read', limit: { name: 'investigate-trace', max: 30 } });
