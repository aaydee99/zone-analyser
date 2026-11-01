import { HttpError, readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { runAudit } from '@/lib/zone-audit/run';
import { ZONE, latestAudits, zoneHistory, type LatestSort } from '@/lib/zone-audit/store';
import { AUDIT_WINDOWS, DEFAULT_WINDOW } from '@/lib/zone-audit/types';

export const dynamic = 'force-dynamic';

/**
 * Stored security audits (no Cloudflare call): ?zone=ID — that zone's audits, newest first (at most 20);
 * otherwise the newest audit of every zone, a page at a time (&q=, &sort=worst|newest|name, &offset, &limit: 50, at most 200).
 */
export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  const zone = q.get('zone');
  if (zone !== null) {
    if (!ZONE.test(zone)) throw new HttpError(400, 'Invalid zone');
    return { audits: await zoneHistory(zone), generatedAt: new Date().toISOString() };
  }
  const sort = (['worst', 'newest', 'name'].includes(q.get('sort') ?? '') ? q.get('sort') : 'worst') as LatestSort;
  const offset = Math.max(0, Math.floor(Number(q.get('offset')) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(q.get('limit')) || 50)));
  const term = (q.get('q') ?? '').trim().slice(0, 100);
  const r = await latestAudits({ q: term, sort, offset, limit });
  return { ...r, offset, limit, sort, generatedAt: new Date().toISOString() };
}, { perm: 'runs:read' });

/**
 * Audits one zone now: { zoneId, hours?: 24|168|720 }. Read-only against Cloudflare (GETs and GraphQL
 * queries with the zone's stored token). Answers with the audit — finished, or still running (ask
 * GET /api/security-audit/{id} until it is not). 10 starts per user per 10 minutes; one per zone at a time.
 */
export const POST = route(async (req, _ctx, me) => {
  const { zoneId, hours } = await readBody<{ zoneId?: unknown; hours?: unknown }>(req);
  if (typeof zoneId !== 'string' || !ZONE.test(zoneId)) throw new HttpError(400, 'Choose a zone');
  const h = hours === undefined ? DEFAULT_WINDOW : Number(hours);
  if (!(AUDIT_WINDOWS as readonly number[]).includes(h)) throw new HttpError(400, `hours must be one of ${AUDIT_WINDOWS.join(', ')}`);
  const a = await runAudit(zoneId, h, me.email);
  await audit(me, 'zone_audit.started', a.zoneName || zoneId, { zoneId, audit: a.id, hours: h });
  return { audit: a };
}, { perm: 'runs:read', limit: { name: 'zone-audit', max: 10, windowMs: 600_000 } });
