import 'server-only';
import { BorderStyle, Document, Footer, HeadingLevel, Packer, PageNumber, PageOrientation, Paragraph, ShadingType, Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType } from 'docx';
import { groupOf, statusText, whatOf, type ZoneDiffReport } from './zone-diff-groups';
import type { ItemDiff } from './zone-index';

// The zone vs zone report as a Word document: landscape US Letter (four columns of values need the
// width), Arial, navy headings and table headers that repeat on every page, a summary table, then one
// section per group (Origin rules, Cache rules, DNS records, ...). Values are shown in full.

const NAVY = '1F3864';
const GRID = 'BFC8D6';
const BAD = 'B42318';
const WARN = 'A15C07';
/** Text width in twips: 11 in landscape less two 0.75 in margins. */
const WIDTH = 13680;
const border = { style: BorderStyle.SINGLE, size: 4, color: GRID };
const borders = { top: border, bottom: border, left: border, right: border };

function cell(text: string, w: number, o: { header?: boolean; mono?: boolean; color?: string; bold?: boolean; muted?: string } = {}) {
  const lines = text ? text.split('\n') : ['—'];
  return new TableCell({
    width: { size: w, type: WidthType.DXA }, borders, verticalAlign: VerticalAlign.TOP,
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
    shading: o.header ? { type: ShadingType.CLEAR, color: 'auto', fill: NAVY } : undefined,
    children: [
      ...lines.map((t) => new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: t, size: o.mono ? 16 : 18, font: o.mono ? 'Consolas' : undefined, bold: o.header || o.bold, color: o.header ? 'FFFFFF' : text ? o.color : '808080' })] })),
      ...(o.muted ? [new Paragraph({ spacing: { before: 40, after: 0 }, children: [new TextRun({ text: o.muted, size: 14, font: 'Consolas', color: '6B7280' })] })] : []),
    ],
  });
}

function table(head: string[], widths: number[], rows: TableCell[][]) {
  return new Table({
    width: { size: WIDTH, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED,
    rows: [new TableRow({ tableHeader: true, cantSplit: true, children: head.map((h, i) => cell(h, widths[i], { header: true })) }), ...rows.map((r) => new TableRow({ cantSplit: true, children: r }))],
  });
}

const p = (text: string, o: { size?: number; color?: string; bold?: boolean; after?: number } = {}) => new Paragraph({ spacing: { after: o.after ?? 100 }, children: [new TextRun({ text, size: o.size, color: o.color, bold: o.bold })] });
const n = (x: number) => x.toLocaleString('en-US');

export async function zoneDiffDocx(r: ZoneDiffReport, o: { brand: string; at: string }): Promise<Buffer> {
  const W = [3400, 1600, 4340, 4340];
  const byGroup = new Map<string, ItemDiff[]>();
  for (const d of r.diffs) { const k = groupOf(d).key; byGroup.set(k, [...(byGroup.get(k) ?? []), d]); }
  const body = [
    new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 120 }, children: [new TextRun({ text: `${r.a.name} vs ${r.b.name}`, color: NAVY, bold: true, size: 40 })] }),
    p(`Zone comparison · ${o.at} · ${o.brand}`, { color: '595959' }),
    p(`Zone A: ${r.a.name} (${r.a.id})`, { size: 20 }),
    p(`Zone B: ${r.b.name} (${r.b.id})`, { size: 20, after: 200 }),
    table(['Different values', `Only in ${r.a.name}`, `Only in ${r.b.name}`, 'The same'], [3420, 3420, 3420, 3420],
      [[cell(n(r.counts.different), 3420, { bold: true }), cell(n(r.counts.onlyA), 3420, { bold: true }), cell(n(r.counts.onlyB), 3420, { bold: true }), cell(n(r.same), 3420, { bold: true })]]),
    p('From each zone\'s stored configuration (its newest backup and drift snapshot). Each zone\'s own name is written as {zone}, so names that naturally differ do not count. Rules are compared by their position in the phase: rule 2 in one zone against rule 2 in the other.', { size: 18, color: '595959', after: 200 }),
  ];
  if (!r.diffs.length) body.push(p('The two zones have the same stored configuration.', { bold: true }));
  else {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, keepNext: true, children: [new TextRun({ text: 'Summary', color: NAVY })] }));
    body.push(table(['Type', 'Different', 'Only in A', 'Only in B', 'Total'], [5480, 2050, 2050, 2050, 2050],
      r.groups.map((g) => [cell(g.label, 5480), cell(n(g.different), 2050), cell(n(g.onlyA), 2050), cell(n(g.onlyB), 2050), cell(n(g.total), 2050, { bold: true })])));
    for (const g of r.groups) {
      body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, keepNext: true, children: [new TextRun({ text: g.label, color: NAVY }), new TextRun({ text: `   ${n(g.total)} difference${g.total === 1 ? '' : 's'}`, size: 20, color: '595959' })] }));
      body.push(table(['What', 'Status', r.a.name, r.b.name], W, (byGroup.get(g.key) ?? []).map((d) => [
        cell(whatOf(d), W[0], { muted: d.item }),
        cell(statusText(d.status, r), W[1], { color: d.status === 'different' ? BAD : WARN, bold: true }),
        cell(d.a.join('\n'), W[2], { mono: true }),
        cell(d.b.join('\n'), W[3], { mono: true }),
      ])));
    }
  }
  const doc = new Document({
    creator: o.brand, title: `${r.a.name} vs ${r.b.name}`,
    styles: { default: { document: { run: { font: 'Arial', size: 20 } } } },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840, orientation: PageOrientation.LANDSCAPE }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
      footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: `${r.a.name} vs ${r.b.name} · page `, size: 16, color: '808080' }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '808080' })] })] }) },
      children: body,
    }],
  });
  return Packer.toBuffer(doc);
}
