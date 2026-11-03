import 'server-only';
import {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType,
} from 'docx';
import type { ClientReport, ClientSeverity, GapStatus, ThreatState } from './client-report';

// The client report (client-report.ts) as a Word document: US Letter, Arial, navy headings and table
// headers, tinted label cells on the gap cards, severity and status colours, header and footer on
// every page but the cover, rows that never split and header rows that repeat.

const NAVY = '1F3864';
const LABEL_FILL = 'EEF2F8';
const GRID = 'BFC8D6';
const SEVERITY_COLOR: Record<ClientSeverity, string> = { Critical: 'C00000', High: 'C00000', Medium: 'B45F06', Low: '2E75B6', Advisory: '595959' };
const STATUS_COLOR: Record<ThreatState | GapStatus, string> = { Gap: 'C00000', 'Partly covered': 'B45F06', Covered: '2E7D32', 'Not assessed': '595959', Confirmed: 'C00000', 'To validate': 'B45F06' };
/** Text width of the page in twips (8.5 in less two 1 in margins). */
const WIDTH = 9360;

const border = { style: BorderStyle.SINGLE, size: 4, color: GRID };
const borders = { top: border, bottom: border, left: border, right: border };
const p = (text: string, o: { color?: string; bold?: boolean; size?: number; after?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {}) =>
  new Paragraph({ alignment: o.align, spacing: { after: o.after ?? 80 }, children: [new TextRun({ text, color: o.color, bold: o.bold, size: o.size })] });
const h1 = (text: string, pageBreakBefore = false) => new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore, keepNext: true, children: [new TextRun(text)] });
const h2 = (text: string) => new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, children: [new TextRun(text)] });
const bullet = (text: string) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun(text)] });

function cell(lines: string[] | string, w: number, o: { fill?: string; color?: string; bold?: boolean; header?: boolean } = {}) {
  const ls = Array.isArray(lines) ? lines : [lines];
  return new TableCell({
    width: { size: w, type: WidthType.DXA }, borders, verticalAlign: VerticalAlign.TOP,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    shading: o.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: o.fill } : undefined,
    children: (ls.length ? ls : ['']).map((t, i) => new Paragraph({ spacing: { after: i === ls.length - 1 ? 0 : 60 }, children: [new TextRun({ text: t, color: o.header ? 'FFFFFF' : o.color, bold: o.bold || o.header, size: 18 })] })),
  });
}

/** A table with a navy header row that repeats on every page; no row is split across pages. */
function table(head: string[], widths: number[], rows: (string | { text: string; color: string })[][]) {
  return new Table({
    width: { size: WIDTH, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: head.map((h, i) => cell(h, widths[i], { fill: NAVY, header: true })) }),
      ...rows.map((r) => new TableRow({ cantSplit: true, children: r.map((c, i) => (typeof c === 'string' ? cell(c, widths[i]) : cell(c.text, widths[i], { color: c.color }))) })),
    ],
  });
}

const space = (after = 160) => new Paragraph({ spacing: { after }, children: [] });

export async function clientReportDocx(r: ClientReport): Promise<Buffer> {
  const cover = [
    new Paragraph({ spacing: { before: 2400, after: 240 }, children: [new TextRun({ text: 'Cloudflare Security Review', bold: true, size: 56, color: NAVY })] }),
    new Paragraph({ spacing: { after: 720 }, children: [new TextRun({ text: 'Gaps and recommendations', size: 36, color: NAVY })] }),
    p(r.zone, { size: 28, after: 240 }),
    p(`Prepared for ${r.client}`, { size: 24 }),
    p('Prepared by Adapture', { size: 24 }),
    p(r.preparedOn, { size: 24 }),
    ...(r.window ? [p(`Traffic window: ${r.window}`, { size: 22, color: '595959' })] : []),
    new Paragraph({ spacing: { before: 3600 }, children: [new TextRun({ text: `Confidential. This document is prepared for ${r.client} and describes the security configuration of its Cloudflare zone. Do not share it outside the people responsible for that zone.`, size: 18, color: '595959' })] }),
  ];

  const sev = (s: ClientSeverity) => ({ text: s, color: SEVERITY_COLOR[s] });
  const executive = [
    h1('Executive summary', true),
    ...r.executive.situation.map((s) => p(s)),
    ...(r.executive.priorities.length ? [h2('Priorities'), ...r.executive.priorities.map(bullet)] : []),
    h2('Findings by severity'),
    table(['Severity', 'Findings', 'Confirmed', 'To validate'], [2760, 2200, 2200, 2200], [
      ...r.executive.counts.map((c) => [sev(c.severity), String(c.findings), String(c.confirmed), String(c.toValidate)]),
      ['Total', String(r.executive.total), String(r.executive.counts.reduce((n, c) => n + c.confirmed, 0)), String(r.executive.counts.reduce((n, c) => n + c.toValidate, 0))],
    ]),
    p('Findings are grouped by root cause into the gaps below, so one gap can hold several findings.', { color: '595959', size: 18 }),
  ];

  const scope = [h1('Scope and approach'), ...r.scope.map((s) => p(s)), h2('Limits'), ...r.limits.map(bullet)];

  const threats = [
    h1('Current coverage by threat', true),
    table(['Threat', 'Status', 'In place', 'Main gap'], [2600, 1500, 2860, 2400], r.threats.map((t) => [t.threat, { text: t.status, color: STATUS_COLOR[t.status] }, t.inPlace, t.mainGap])),
  ];

  const summary = r.gaps.length ? [
    h1('Summary of gaps'),
    table(['ID', 'Gap', 'Severity', 'Recommendation'], [700, 3000, 1300, 4360], r.gaps.map((g) => [g.id, g.title, sev(g.severity), g.recommendation])),
  ] : [h1('Summary of gaps'), p('No gaps were found in the checks that could be read.')];

  const LABEL_W = 2000;
  const cards = r.gaps.flatMap((g) => [
    new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, children: [new TextRun(`${g.id}. ${g.title}`)] }),
    new Paragraph({ keepNext: true, spacing: { after: 100 }, children: [
      new TextRun({ text: 'Severity: ', color: '595959' }), new TextRun({ text: g.severity, color: SEVERITY_COLOR[g.severity] }),
      new TextRun({ text: '    Status: ', color: '595959' }), new TextRun({ text: g.status, color: STATUS_COLOR[g.status] }),
      new TextRun({ text: `    Findings: ${g.findings}`, color: '595959' }),
    ] }),
    new Table({
      width: { size: WIDTH, type: WidthType.DXA }, columnWidths: [LABEL_W, WIDTH - LABEL_W], layout: TableLayoutType.FIXED,
      // Rows never split, and each keeps with the next: a card that fits on a page is never split across two.
      rows: g.rows.map((row, k) => new TableRow({ cantSplit: true, keepNext: k < g.rows.length - 1, children: [cell(row.label, LABEL_W, { fill: LABEL_FILL, bold: true, color: NAVY }), cell(row.lines, WIDTH - LABEL_W)] })),
    }),
    space(240),
  ]);
  const gapsSection = r.gaps.length ? [h1('Gaps and recommendations', true), p('Each gap lists what was found, the evidence, the risk, what to confirm first, the recommendation, and what to check before rolling it out.'), ...cards] : [];

  const roadmap = [
    h1('Recommended roadmap', true),
    ...r.roadmap.phases.flatMap((ph) => [h2(ph.title), p(ph.why, { color: '595959' }), ...ph.items.map(bullet)]),
    h2('Input needed from you'), ...r.roadmap.inputs.map(bullet),
    h2('How progress is measured'), ...r.roadmap.measures.map(bullet),
  ];

  const working = r.working.length ? [h1('What is working well'), ...r.working.flatMap((w) => [h2(w.area), ...w.items.map(bullet)])] : [];

  const appendices = r.appendices.length ? [
    h1('Appendices', true),
    ...r.appendices.flatMap((a, i) => [h2(`Appendix ${String.fromCharCode(65 + i)}. ${a.title}`), p(a.intro, { color: '595959' }), table(a.head, [2800, 1300, 1500, 3760], a.rows), space()]),
  ] : [];

  const doc = new Document({
    creator: 'Adapture', title: `Cloudflare Security Review: ${r.zone}`, description: 'Gaps and recommendations',
    styles: {
      default: { document: { run: { font: 'Arial', size: 20 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Arial', size: 32, bold: true, color: NAVY }, paragraph: { spacing: { before: 240, after: 160 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Arial', size: 24, bold: true, color: NAVY }, paragraph: { spacing: { before: 240, after: 100 } } },
      ],
    },
    sections: [{
      properties: { titlePage: true, page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 600, footer: 600 } } },
      headers: {
        first: new Header({ children: [new Paragraph({ children: [] })] }),
        default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: `${r.zone} | Cloudflare Security Review: Gaps and recommendations`, size: 16, color: '595959' })] })] }),
      },
      footers: {
        first: new Footer({ children: [new Paragraph({ children: [] })] }),
        default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Adapture | Confidential | Page ', PageNumber.CURRENT], size: 16, color: '595959' })] })] }),
      },
      children: [...cover, ...executive, ...scope, ...threats, ...summary, ...gapsSection, ...roadmap, ...working, ...appendices],
    }],
  });
  return Packer.toBuffer(doc);
}
