import { HttpError, route } from '@/lib/http';
import { getAudit } from '@/lib/zone-audit/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ auditId: string }> };

/** One stored audit with its report (null while it runs). No Cloudflare call. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const a = await getAudit((await params).auditId);
  if (!a) throw new HttpError(404, 'Audit not found');
  return { audit: a, generatedAt: new Date().toISOString() };
}, { perm: 'runs:read' });
