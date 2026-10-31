import { HttpError, route } from '@/lib/http';
import { liveJob } from '@/lib/logpush';

export const dynamic = 'force-dynamic';

/** One job as Cloudflare has it now, to edit: ?scope=account|zone&scopeId=&jobId=. The destination shows its host only. */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const scope = u.get('scope');
  if (scope !== 'account' && scope !== 'zone') throw new HttpError(400, 'scope must be account or zone');
  const jobId = Number(u.get('jobId'));
  if (!Number.isInteger(jobId) || jobId < 1) throw new HttpError(400, 'Unknown Logpush job');
  return { job: await liveJob(scope, u.get('scopeId') ?? '', jobId) };
}, { perm: 'cloudflare:act' });
