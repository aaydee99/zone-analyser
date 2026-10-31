import { route } from '@/lib/http';
import { computeTemplate, getTemplate } from '@/lib/compare';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Computes a template's gaps for every indexed zone again, in the background (from stored data only). */
export const POST = route<Ctx>(async (_req, { params }) => {
  const t = await getTemplate((await params).id);
  return { job: computeTemplate(t.id) };
}, { perm: 'zones:tag', limit: { name: 'template-compute', max: 20, windowMs: 10 * 60_000 } });
