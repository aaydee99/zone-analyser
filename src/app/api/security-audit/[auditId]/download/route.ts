import { HttpError, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { BRAND } from '@/lib/brand';
import { attachment } from '@/lib/zone-routes';
import { auditCsv, auditMarkdown, findingsJson, isCsvPart } from '@/lib/zone-audit/render';
import { clientReport } from '@/lib/zone-audit/client-report';
import { clientReportDocx } from '@/lib/zone-audit/client-report-docx';
import { getAudit } from '@/lib/zone-audit/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ auditId: string }> };

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** The client name on the cover: one line, at most 120 characters. */
const clientName = (v: string | null) => (v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

/**
 * An audit as a file: ?format=json (findings.json), md (REPORT.md), csv[&part=findings|coverage|effectiveness],
 * or docx&client=NAME (the client version, "Gaps and recommendations": src/lib/zone-audit/client-report.ts).
 */
export const GET = route<Ctx>(async (req, { params }, me) => {
  const a = await getAudit((await params).auditId);
  if (!a) throw new HttpError(404, 'Audit not found');
  if (!a.report) throw new HttpError(409, a.status === 'running' ? 'The audit is still running' : 'This audit did not finish, so there is nothing to download');
  const q = new URL(req.url).searchParams;
  const format = q.get('format') ?? 'md';
  const base = `${a.zoneName || a.zoneId}-security-audit-${a.startedAt.slice(0, 10)}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  let res: Response;
  if (format === 'json') res = attachment(`${base}-findings.json`, findingsJson(a.report), 'application/json; charset=utf-8');
  else if (format === 'md') res = attachment(`${base}-REPORT.md`, auditMarkdown(a.report, BRAND.name), 'text/markdown; charset=utf-8');
  else if (format === 'csv') {
    const part = q.get('part') ?? 'findings';
    if (!isCsvPart(part)) throw new HttpError(400, 'part must be findings, coverage, effectiveness or managed');
    res = attachment(`${base}-${part}.csv`, auditCsv(a.report, part), 'text/csv; charset=utf-8');
  } else if (format === 'docx') {
    const client = clientName(q.get('client'));
    if (!client) throw new HttpError(400, 'Name the client the report is for');
    const report = clientReport(a.report, { client });
    const name = report.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
    res = new Response(new Uint8Array(await clientReportDocx(report)), { headers: { 'Content-Type': DOCX, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } });
  } else throw new HttpError(400, 'format must be json, md, csv or docx');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  await audit(me, 'zone_audit.downloaded', a.zoneName || a.zoneId, { audit: a.id, format, ...(format === 'docx' ? { client: clientName(q.get('client')) } : {}) });
  return res;
}, { perm: 'runs:read', on: 'web', limit: { name: 'zone-audit-download', max: 30 } });
