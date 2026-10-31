import { HttpError, readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { importCsv } from '@/lib/zone-meta';

export const dynamic = 'force-dynamic';

/** Imports tags, owners, contacts and notes from CSV ({ csv, dryRun }); dryRun only checks the file. */
export const POST = route(async (req, _ctx, me) => {
  const { csv, dryRun } = await readBody<{ csv?: string; dryRun?: boolean }>(req);
  if (typeof csv !== 'string' || !csv.trim()) throw new HttpError(400, 'Choose a CSV file');
  const r = await importCsv(csv, me.email, dryRun === true);
  if (!r.dryRun && r.changed) await audit(me, 'zone_meta.imported', `${r.changed} zone${r.changed === 1 ? '' : 's'}`, { rows: r.rows, matched: r.matched, changed: r.changed, unknown: r.unknownCount });
  return r;
}, { perm: 'zones:tag', limit: { name: 'zone-meta-import', max: 20 } });
