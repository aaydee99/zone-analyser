import { HttpError, readBody, route } from '@/lib/http';
import { runState, startRun } from '@/lib/monitor-runner';
import { CHECKS, isCheckId } from '@/lib/monitor-types';

export const dynamic = 'force-dynamic';

/** Whether checks are running, and which one. */
export const GET = route(async () => runState(), { perm: 'runs:read' });

/** Runs checks now, in the background: { checks?: CheckId[] } (all when left out). */
export const POST = route(async (req, _ctx, me) => {
  const body = await readBody<{ checks?: unknown[] }>(req).catch(() => ({} as { checks?: unknown[] }));
  const ids = Array.isArray(body.checks) && body.checks.length ? body.checks.filter(isCheckId) : CHECKS.map((c) => c.id);
  if (!ids.length) throw new HttpError(400, 'Unknown check');
  if (!startRun([...new Set(ids)], me, me.email)) throw new HttpError(409, 'Checks are already running — wait for them to finish');
  return runState();
}, { perm: 'monitors:manage', limit: { name: 'monitors-run', max: 10, windowMs: 10 * 60_000 } });
