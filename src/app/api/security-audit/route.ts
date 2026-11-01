import { HttpError, readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { runAudit, startAccountAudit } from '@/lib/zone-audit/run';
import { ZONE, latestAudits, zoneHistory, type LatestSort } from '@/lib/zone-audit/store';
import { zoneOf } from '@/lib/zone-explorer';
import { AUDIT_WINDOWS, DEFAULT_WINDOW } from '@/lib/zone-audit/types';

export const dynamic = 'force-dynamic';
const ACCOUNT = /^[a-f0-9]{32}$/i;

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
 * Audits one zone now: { accountId, zoneId, hours?: 24|168|720 } (the zone must be in the account),
 * or every zone of the account when zoneId is left out (answers with its progress: GET
 * /api/security-audit/account). Read-only against Cloudflare (GETs and GraphQL queries with the stored
 * token). A zone's audit answers finished, or still running (ask GET /api/security-audit/{id} until it
 * is not). 10 starts per user per 10 minutes; one audit per zone and one account audit at a time.
 */
export const POST = route(async (req, _ctx, me) => {
  const { accountId, zoneId, hours } = await readBody<{ accountId?: unknown; zoneId?: unknown; hours?: unknown }>(req);
  if (typeof accountId !== 'string' || !ACCOUNT.test(accountId)) throw new HttpError(400, 'Choose an account');
  if (zoneId !== undefined && zoneId !== null && zoneId !== '' && (typeof zoneId !== 'string' || !ZONE.test(zoneId))) throw new HttpError(400, 'Invalid zone');
  const h = hours === undefined ? DEFAULT_WINDOW : Number(hours);
  if (!(AUDIT_WINDOWS as readonly number[]).includes(h)) throw new HttpError(400, `hours must be one of ${AUDIT_WINDOWS.join(', ')}`);
  if (typeof zoneId !== 'string' || !zoneId) {
    const b = await startAccountAudit(accountId, h, me.email);
    await audit(me, 'zone_audit.account_started', b.accountName, { accountId, zones: b.total, hours: h });
    return { account: b };
  }
  const { zone } = await zoneOf(zoneId);
  if (zone.accountId !== accountId) throw new HttpError(400, 'That zone is not in the chosen account');
  const a = await runAudit(zoneId, h, me.email);
  await audit(me, 'zone_audit.started', a.zoneName || zoneId, { zoneId, audit: a.id, hours: h });
  return { audit: a };
}, { perm: 'runs:read', limit: { name: 'zone-audit', max: 10, windowMs: 600_000 } });
