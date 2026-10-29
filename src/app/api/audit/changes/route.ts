import { route } from '@/lib/http';
import { auditSince } from '@/lib/audit';
import { buildReport } from '@/lib/audit-changes';

export const dynamic = 'force-dynamic';

/** Changes recorded in the audit log over the last `days` (1–30, default 7), plus activity counts. */
export const GET = route(async (req) => {
  const n = Math.round(Number(new URL(req.url).searchParams.get('days') ?? 7));
  const days = Number.isFinite(n) ? Math.min(30, Math.max(1, n)) : 7;
  const until = new Date();
  const since = new Date(until.getTime() - days * 86_400_000);
  const { entries, truncated } = await auditSince(since);
  return buildReport(entries, since, until, days, truncated);
}, { perm: 'audit:read' });
