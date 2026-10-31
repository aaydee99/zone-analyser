import { HttpError, route } from '@/lib/http';
import { backgroundAnswer } from '@/lib/investigate-jobs';
import { lookupRay, parseRay } from '@/lib/ray-lookup';

export const dynamic = 'force-dynamic';

/**
 * Finds a Ray ID: ?ray=…[&zone=ID | &host=… | &account=ID | &all=1][&hours=24][&at=ISO time]. Any role.
 * Read from Cloudflare's GraphQL Analytics in the background: 202 with how far it got and its `job`
 * until it is done (ask again with &job=…).
 */
export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  const ray = parseRay(q.get('ray') ?? '');
  if (!ray) throw new HttpError(400, 'Not a Ray ID (16 hex characters, optionally with the data center, e.g. 8f3a1b2c4d5e6f70-AMS)');
  const opts = {
    zoneId: q.get('zone') || undefined, host: q.get('host') || undefined, accountId: q.get('account') || undefined, all: q.get('all') === '1',
    hours: q.get('hours') ? Number(q.get('hours')) : undefined, at: q.get('at') || undefined,
  };
  const key = `ray:${ray}:${opts.zoneId ?? ''}:${opts.host ?? ''}:${opts.accountId ?? ''}:${opts.all ? 1 : 0}:${opts.hours ?? ''}:${opts.at ?? ''}`;
  return backgroundAnswer(key, q.get('job'), (progress) => lookupRay(ray, { ...opts, progress }));
}, { perm: 'runs:read', limit: { name: 'investigate-ray', max: 120 } });
