import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { trafficMonths } from '@/lib/traffic';
import { zoneDetail } from '@/lib/traffic-security';
import { isFresh } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';

/**
 * One zone's security events (rules that matched, actions, IPs, paths …) and request breakdowns for a month
 * (?month=YYYY-MM&account=ID&zone=ID), optionally narrowed to one client IP (&ip=…), one rule (&rule=…) or one ruleset (&ruleset=…), and to one day (&day=YYYY-MM-DD) or hour of it (&hour=0–23).
 * Any role. While Cloudflare is still being read: 202 with how far it got — ask again in a few seconds.
 */
export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  const r = await zoneDetail(q.get('month') || trafficMonths()[0], q.get('account') ?? '', q.get('zone') ?? '',
    { ip: q.get('ip') || undefined, rule: q.get('rule') || undefined, ruleset: q.get('ruleset') || undefined, day: q.get('day') || undefined, hour: q.get('hour') ? Number(q.get('hour')) : undefined }, isFresh(req));
  return 'pending' in r ? NextResponse.json(r, { status: 202, headers: { 'Retry-After': '3' } }) : r;
}, { perm: 'runs:read', limit: { name: 'traffic-detail', max: 120 } });
