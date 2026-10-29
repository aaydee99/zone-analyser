import 'server-only';
import type { Me } from './auth';
import { audit } from './audit';
import { HttpError } from './http';
import type { ZoneListItem } from './zone-catalog';

// Shared by the zone explorer's API routes: the zone id check, view auditing and file answers.

export async function zoneIdOf(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(404, 'Zone not found');
  return id;
}

export const isFresh = (req: Request) => new URL(req.url).searchParams.get('fresh') === '1';

// A zone opens with about 17 section requests: record one view per person and zone every 10 minutes.
const g = globalThis as unknown as { __zoneViews?: Map<string, number> };
const views = (g.__zoneViews ??= new Map());

export async function auditView(me: Me, zone: Pick<ZoneListItem, 'id' | 'name' | 'accountName'>, details: Record<string, unknown> = {}) {
  const key = `${me.id}:${zone.id}`;
  const last = views.get(key);
  if (last && Date.now() - last < 10 * 60_000) return;
  views.set(key, Date.now());
  if (views.size > 2000) views.delete(views.keys().next().value!);
  await audit(me, 'cloudflare_zone.viewed', zone.name, { zoneId: zone.id, account: zone.accountName, ...details });
}

/** A download: an attachment that is never stored by the browser or a proxy. */
export function attachment(name: string, body: string, type: string) {
  return new Response(body, {
    headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"`, 'Cache-Control': 'no-store' },
  });
}
