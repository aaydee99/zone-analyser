import { HttpError, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { BRAND } from '@/lib/brand';
import { ZONE_ID, zoneDiffReport } from '@/lib/compare';
import { zoneDiffCsv, zoneDiffHtml } from '@/lib/zone-diff-groups';
import { zoneDiffDocx } from '@/lib/zone-diff-docx';
import { attachment } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** When the report was made, in US Eastern time. */
const eastern = (iso: string) => `${new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })} ET`;

/**
 * Two zones' differences as a file: ?a=<zone id>&b=<zone id>&format=docx|html|csv[&group=phase:<phase>|kind:<kind>][&status=only-a|only-b|different].
 * Every difference (no paging), grouped as the page groups them. Read-only.
 */
export const GET = route(async (req, _ctx, me) => {
  const u = new URL(req.url).searchParams;
  const a = u.get('a') ?? '', b = u.get('b') ?? '';
  if (!ZONE_ID.test(a) || !ZONE_ID.test(b)) throw new HttpError(400, 'Choose two zones');
  const format = u.get('format') ?? 'docx';
  if (!['docx', 'html', 'csv'].includes(format)) throw new HttpError(400, 'format must be docx, html or csv');
  const r = await zoneDiffReport(a, b, { group: u.get('group') || undefined, status: u.get('status') || undefined });
  const o = { brand: BRAND.name, at: eastern(r.generatedAt) };
  const base = `${r.a.name}-vs-${r.b.name}-${r.generatedAt.slice(0, 10)}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  let res: Response;
  if (format === 'csv') res = attachment(`${base}.csv`, zoneDiffCsv(r), 'text/csv; charset=utf-8');
  else if (format === 'html') res = attachment(`${base}.html`, zoneDiffHtml(r, o), 'text/html; charset=utf-8');
  else res = new Response(new Uint8Array(await zoneDiffDocx(r, o)), { headers: { 'Content-Type': DOCX, 'Content-Disposition': `attachment; filename="${base}.docx"`, 'Cache-Control': 'no-store' } });
  res.headers.set('X-Content-Type-Options', 'nosniff');
  await audit(me, 'compare.zone_diff_downloaded', `${r.a.name} vs ${r.b.name}`, { a, b, format, differences: r.diffs.length });
  return res;
}, { perm: 'runs:read', on: 'web', limit: { name: 'compare-zone-report', max: 30 } });
