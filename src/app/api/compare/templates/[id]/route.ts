import { readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { deleteTemplate, getTemplate, updateTemplate } from '@/lib/compare';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** One template with its items. */
export const GET = route<Ctx>(async (_req, { params }) => ({ template: await getTemplate((await params).id) }), { perm: 'runs:read' });

/** Changes a template: { name?, description?, items? } (its kept results are computed again). */
export const PUT = route<Ctx>(async (req, { params }, me) => {
  const { template, changed } = await updateTemplate((await params).id, me.email, await readBody<Record<string, unknown>>(req));
  if (changed.length) await audit(me, 'compare.template_updated', template.name, { templateId: template.id, changed, items: template.items.length });
  return { template };
}, { perm: 'zones:tag' });

export const DELETE = route<Ctx>(async (_req, { params }, me) => {
  const t = await deleteTemplate((await params).id);
  await audit(me, 'compare.template_deleted', t.name, { templateId: t.id });
  return { ok: true };
}, { perm: 'zones:tag' });
