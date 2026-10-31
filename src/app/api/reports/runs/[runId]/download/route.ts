import { HttpError, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { BRAND } from '@/lib/brand';
import { getRun } from '@/lib/report-store';
import { reportHtml, sectionCsv } from '@/lib/report-render';
import { isSection } from '@/lib/report-types';
import { attachment } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ runId: string }> };

/** A report as a file: ?format=html (the whole report), or ?format=csv&section=<key> (one section). */
export const GET = route<Ctx>(async (req, { params }, me) => {
  const run = await getRun((await params).runId);
  if (!run) throw new HttpError(404, 'Report not found');
  if (!run.content) throw new HttpError(409, run.status === 'running' ? 'The report is still being made' : 'This report could not be made, so there is nothing to download');
  const q = new URL(req.url).searchParams;
  const format = q.get('format') ?? 'html';
  const base = `${run.content.name}-${run.periodEnd.slice(0, 10)}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  if (format === 'html') {
    await audit(me, 'report.downloaded', run.content.name, { run: run.id, format });
    const res = attachment(`${base}.html`, reportHtml(run.content, BRAND.name), 'text/html; charset=utf-8');
    // Meant to be opened from disk; should a browser render it from the console, nothing in it runs.
    res.headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.headers.set('X-Content-Type-Options', 'nosniff');
    return res;
  }
  if (format !== 'csv') throw new HttpError(400, 'format must be html or csv');
  const section = q.get('section') ?? '';
  if (!isSection(section)) throw new HttpError(400, 'Choose a section');
  const csv = sectionCsv(run.content, section);
  if (csv === null) throw new HttpError(404, 'This report has no such section');
  await audit(me, 'report.downloaded', run.content.name, { run: run.id, format, section });
  return attachment(`${base}-${section}.csv`, csv, 'text/csv; charset=utf-8');
}, { perm: 'runs:read', limit: { name: 'report-download', max: 30 } });
