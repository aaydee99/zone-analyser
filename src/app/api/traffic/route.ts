import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { trafficMonths, trafficReport } from '@/lib/traffic';
import { isFresh } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';

/**
 * One month of traffic (?month=YYYY-MM, this month by default) for everything, per account and per zone
 * (any role). While Cloudflare is still being read: 202 with how far it got — ask again in a few seconds.
 */
export const GET = route(async (req) => {
  const month = new URL(req.url).searchParams.get('month') || trafficMonths()[0];
  const r = await trafficReport(month, isFresh(req));
  return 'pending' in r ? NextResponse.json(r, { status: 202, headers: { 'Retry-After': '3' } }) : r;
}, { perm: 'runs:read', limit: { name: 'traffic', max: 120 } });
