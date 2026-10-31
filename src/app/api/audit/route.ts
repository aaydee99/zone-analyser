import { route } from '@/lib/http';
import { listAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  return { entries: await listAudit({ before: Number(q.get('before')) || undefined, action: /^[a-z_.]{1,64}$/.test(q.get('action') ?? '') ? q.get('action')! : undefined, limit: 100 }) };
}, { perm: 'audit:read' });
