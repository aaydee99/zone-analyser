import { HttpError, readBody, route } from '@/lib/http';
import { compareFile } from '@/lib/onboarding';

export const dynamic = 'force-dynamic';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Compares a BIND zone file with the zone's records on Cloudflare: { zoneId, text (at most 512 KB), fresh? }.
 * Read-only: one GET of Cloudflare's own export (kept five minutes; `fresh` reads it again). Nothing is stored.
 */
export const POST = route(async (req) => {
  const body = await readBody<{ zoneId?: unknown; text?: unknown; fresh?: unknown }>(req);
  if (typeof body.zoneId !== 'string' || !ID.test(body.zoneId)) throw new HttpError(400, 'Choose a zone');
  if (typeof body.text !== 'string') throw new HttpError(400, 'Paste or upload a zone file first');
  return compareFile(body.zoneId, body.text, body.fresh === true);
}, { perm: 'runs:read', limit: { name: 'onboarding-compare', max: 30, windowMs: 5 * 60_000 } });
