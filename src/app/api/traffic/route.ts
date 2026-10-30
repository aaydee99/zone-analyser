import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { trafficMonths, trafficReport } from '@/lib/traffic';
import { isFresh } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';

/**
 * One month of traffic for one account (?account=ID: its zones added up, and each zone) or one zone of
 * it (&zone=ID); ?month=YYYY-MM, this month by default. Any role. Only the chosen zones are read.
 * While Cloudflare is still being read: 202 with how far it got — ask again in a few seconds.
 */
export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  const r = await trafficReport(q.get('month') || trafficMonths()[0], q.get('account') ?? '', q.get('zone') || undefined, isFresh(req));
  return 'pending' in r ? NextResponse.json(r, { status: 202, headers: { 'Retry-After': '3' } }) : r;
}, { perm: 'runs:read', limit: { name: 'traffic', max: 120 } });
