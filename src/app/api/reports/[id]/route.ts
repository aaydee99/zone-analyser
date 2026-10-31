import { HttpError, readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { deleteDefinition, getDefinition, listRuns, updateDefinition } from '@/lib/report-store';
import { cleanDefinition, type DefinitionInput } from '@/lib/report-types';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** One report and its history, newest first (?offset=&limit=, up to 50: the history kept). */
export const GET = route<Ctx>(async (req, { params }) => {
  const d = await getDefinition((await params).id);
  if (!d) throw new HttpError(404, 'Report not found');
  const u = new URL(req.url).searchParams;
  const offset = Math.max(0, Math.floor(Number(u.get('offset')) || 0));
  const limit = Math.min(50, Math.max(1, Math.floor(Number(u.get('limit')) || 50)));
  const { runs, total } = await listRuns(d.id, offset, limit);
  return { definition: d, runs, total, offset, generatedAt: new Date().toISOString() };
}, { perm: 'runs:read' });

/** New settings for a report (the same fields as creating one); its next run is worked out again. */
export const PUT = route<Ctx>(async (req, { params }, me) => {
  const c = cleanDefinition(await readBody<DefinitionInput>(req));
  if (!c.ok) throw new HttpError(400, c.error);
  const before = await getDefinition((await params).id);
  if (!before) throw new HttpError(404, 'Report not found');
  const d = await updateDefinition(before.id, c.value, me.email);
  if (!d) throw new HttpError(404, 'Report not found');
  const changed = Object.fromEntries((['name', 'scope', 'accounts', 'tags', 'cadence', 'weekday', 'hour', 'sections', 'channels', 'enabled'] as const)
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(d[k])).map((k) => [k, { from: before[k], to: d[k] }]));
  await audit(me, 'report.updated', d.name, { id: d.id, ...changed });
  return { definition: d };
}, { perm: 'monitors:manage' });

/** Deletes a report and its history. */
export const DELETE = route<Ctx>(async (_req, { params }, me) => {
  const d = await deleteDefinition((await params).id);
  if (!d) throw new HttpError(404, 'Report not found');
  await audit(me, 'report.deleted', d.name, { id: d.id });
  return { ok: true };
}, { perm: 'monitors:manage' });
