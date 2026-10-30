import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { trafficMonths } from '@/lib/traffic';
import { zoneDetail } from '@/lib/traffic-security';

export const dynamic = 'force-dynamic';
const POLL_WAIT_MS = 5_000;

/**
 * One zone's security events (rules that matched, actions, IPs, paths …) and request breakdowns for a month
 * (?month=YYYY-MM&account=ID&zone=ID), optionally narrowed to one client IP (&ip=…), one rule (&rule=…) or one ruleset (&ruleset=…), and to one day (&day=YYYY-MM-DD) or hour of it (&hour=0–23).
 * Any role. Always read from Cloudflare, never from the cache. While it is still being read: 202 with how far
 * it got and the read's `job` — ask again in a few seconds with &job=… to get that read's result.
 */
export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  const r = await zoneDetail(q.get('month') || trafficMonths()[0], q.get('account') ?? '', q.get('zone') ?? '',
    { ip: q.get('ip') || undefined, rule: q.get('rule') || undefined, ruleset: q.get('ruleset') || undefined, day: q.get('day') || undefined, hour: q.get('hour') ? Number(q.get('hour')) : undefined }, q.get('job'),
    // A poll of a running read waits briefly: a waiting request holds one of the worker's slots.
    q.get('job') ? POLL_WAIT_MS : undefined);
  return 'pending' in r ? NextResponse.json(r, { status: 202, headers: { 'Retry-After': '3' } }) : r;
}, { perm: 'runs:read', limit: { name: 'traffic-detail', max: 120 } });
