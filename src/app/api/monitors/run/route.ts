import { HttpError, readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { queueView, requestRun } from '@/lib/monitor-queue';
import { CHECKS, isCheckId } from '@/lib/monitor-types';

export const dynamic = 'force-dynamic';

/** The monitoring queue: what is running and due, and each token's share of the rate limit. */
export const GET = route(async () => queueView(), { perm: 'runs:read' });

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Checks now, before scheduled work: { checks?: CheckId[] (all when left out), accountId?, zoneId? }.
 * Asking again while they run only moves them to the front again.
 */
export const POST = route(async (req, _ctx, me) => {
  const body = await readBody<{ checks?: unknown[]; accountId?: unknown; zoneId?: unknown }>(req).catch(() => ({} as { checks?: unknown[]; accountId?: unknown; zoneId?: unknown }));
  const ids = Array.isArray(body.checks) && body.checks.length ? body.checks.filter(isCheckId) : CHECKS.map((c) => c.id);
  if (!ids.length) throw new HttpError(400, 'Unknown check');
  const accountId = typeof body.accountId === 'string' && body.accountId ? body.accountId : undefined;
  const zoneId = typeof body.zoneId === 'string' && body.zoneId ? body.zoneId : undefined;
  if ((accountId && !ID.test(accountId)) || (zoneId && !ID.test(zoneId))) throw new HttpError(400, 'Unknown account or zone');
  const units = await requestRun({ checks: [...new Set(ids)], accountId, zoneId });
  await audit(me, 'monitoring.run_requested', zoneId ?? accountId ?? null, { checks: ids, units });
  return { units, queue: await queueView() };
}, { perm: 'monitors:manage', limit: { name: 'monitors-run', max: 30, windowMs: 10 * 60_000 } });
