import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { trafficPatterns } from '@/lib/traffic-pattern';
import { isFresh } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';

/**
 * The last 30 days of one account's (or one zone's) traffic, hour by hour and the last 24 hours in
 * 5-minute steps, with spikes, drops, busy quiet hours and origin load flagged against its own
 * pattern (src/lib/traffic-anomaly.ts). Any role. ?fresh=1 reads again. While reading: 202.
 */
export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  const r = await trafficPatterns(q.get('account') ?? '', q.get('zone') || undefined, isFresh(req));
  return 'pending' in r ? NextResponse.json(r, { status: 202, headers: { 'Retry-After': '3' } }) : r;
}, { perm: 'runs:read', limit: { name: 'traffic', max: 120 } });
