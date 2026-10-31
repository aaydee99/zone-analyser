import { HttpError, route } from '@/lib/http';
import { ZONE_ID, backupsOf } from '@/lib/compare';

export const dynamic = 'force-dynamic';

/** The backups that hold a zone (?zone=<id>): this server's folders and the approved buckets, newest first. */
export const GET = route(async (req) => {
  const zone = new URL(req.url).searchParams.get('zone') ?? '';
  if (!ZONE_ID.test(zone)) throw new HttpError(400, 'Choose a zone');
  return { ...(await backupsOf(zone)), generatedAt: new Date().toISOString() };
}, { perm: 'runs:read', limit: { name: 'compare-backups', max: 60 } });
