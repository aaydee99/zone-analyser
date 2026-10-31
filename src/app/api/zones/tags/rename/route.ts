import { readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { renameTag } from '@/lib/zone-meta';

export const dynamic = 'force-dynamic';

/** Renames a tag on every zone ({ from, to }); into an existing tag it merges, and an empty `to` removes it. */
export const POST = route(async (req, _ctx, me) => {
  const { from, to } = await readBody<{ from?: string; to?: string }>(req);
  const r = await renameTag(from, to ?? '', me.email);
  if (r.changed) await audit(me, r.to ? 'zone_meta.tag_renamed' : 'zone_meta.tag_removed', r.from, { from: r.from, to: r.to || null, zones: r.changed });
  return r;
}, { perm: 'zones:tag', limit: { name: 'zone-meta-bulk', max: 30 } });
