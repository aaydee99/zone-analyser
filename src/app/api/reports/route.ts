import { HttpError, readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { createDefinition, latestRuns, listDefinitions } from '@/lib/report-store';
import { cleanDefinition, type DefinitionInput } from '@/lib/report-types';

export const dynamic = 'force-dynamic';

/** Scheduled reports by name, a page at a time (?offset=&limit=, up to 200), each with its newest run. */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const offset = Math.max(0, Math.floor(Number(u.get('offset')) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(u.get('limit')) || 50)));
  const { definitions, total } = await listDefinitions(offset, limit);
  const latest = await latestRuns(definitions.map((d) => d.id));
  return { definitions: definitions.map((d) => ({ ...d, latest: latest.get(d.id) ?? null })), total, offset, generatedAt: new Date().toISOString() };
}, { perm: 'runs:read' });

/** A new report: { name, scope, accounts?, tags?, cadence, weekday?, hour, sections, channels, enabled? }. */
export const POST = route(async (req, _ctx, me) => {
  const c = cleanDefinition(await readBody<DefinitionInput>(req));
  if (!c.ok) throw new HttpError(400, c.error);
  const d = await createDefinition(c.value, me.email);
  await audit(me, 'report.created', d.name, { id: d.id, scope: d.scope, cadence: d.cadence, hour: d.hour, weekday: d.weekday, sections: d.sections, channels: d.channels });
  return { definition: d };
}, { perm: 'monitors:manage' });
