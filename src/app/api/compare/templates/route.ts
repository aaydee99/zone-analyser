import { readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { createTemplate, listTemplates } from '@/lib/compare';

export const dynamic = 'force-dynamic';

/** Every comparison template (without their items). */
export const GET = route(async () => ({ templates: await listTemplates(), generatedAt: new Date().toISOString() }), { perm: 'runs:read' });

/** A new template: { name, description?, zoneId (start from that zone's stored configuration), kinds?, prefixes? } or { name, items }. */
export const POST = route(async (req, _ctx, me) => {
  const t = await createTemplate(me.email, await readBody<Record<string, unknown>>(req));
  await audit(me, 'compare.template_created', t.name, { templateId: t.id, items: t.items.length, fromZone: t.sourceZoneName });
  return { template: t };
}, { perm: 'zones:tag' });
