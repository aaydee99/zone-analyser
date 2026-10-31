import { HttpError, route } from '@/lib/http';
import { ZONE_ID, compareBackups } from '@/lib/compare';

export const dynamic = 'force-dynamic';

/** What changed between two backups of a zone: ?zone=<id>&a=<backup ref>&b=<backup ref>&type=&offset=&limit= (up to 200). */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const zone = u.get('zone') ?? '', a = u.get('a') ?? '', b = u.get('b') ?? '';
  if (!ZONE_ID.test(zone)) throw new HttpError(400, 'Choose a zone');
  if (!a || !b || a.length > 400 || b.length > 400) throw new HttpError(400, 'Choose two backups');
  const type = u.get('type') ?? '';
  if (type && !/^cloudflare_[a-z0-9_]{1,80}$/.test(type)) throw new HttpError(400, 'Unknown resource type');
  const page = await compareBackups(zone, a, b, { type: type || undefined, offset: Number(u.get('offset')) || 0, limit: Number(u.get('limit')) || 50 });
  return { ...page, generatedAt: new Date().toISOString() };
}, { perm: 'runs:read', limit: { name: 'compare-backups', max: 60 } });
