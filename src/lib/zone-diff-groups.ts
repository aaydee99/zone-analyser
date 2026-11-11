import { INDEX_KINDS, type IndexKind, type ItemDiff } from './zone-index';
import { PHASES } from './template-library';

// Zone vs zone differences, grouped the way the dashboard groups them: each ruleset phase on its own
// (Origin rules, Cache rules, Configuration rules, Custom rules, Rate limiting, Single redirects, ...),
// then DNS, settings, Page Rules and the rest. Also the report formats (CSV and a printable HTML page);
// the Word version is zone-diff-docx.ts. Pure: the page and the tests use it too.

export interface DiffGroup { key: string; label: string; order: number }
export interface GroupCount extends DiffGroup { onlyA: number; onlyB: number; different: number; total: number }

const RULESET = /^ruleset:([^:]+):(?:(\d+):(.+)|present)$/;
const KIND_ORDER: Record<IndexKind, number> = { dns: 10, setting: 20, rule: 290, header: 300, redirect: 310, pagerule: 320, worker_route: 330, certificate: 340, hostname: 350, script: 360, api: 370, resource: 380 };
const KIND_LABEL = Object.fromEntries(INDEX_KINDS.map((k) => [k.kind, k.label])) as Record<IndexKind, string>;
const PHASE_INDEX = new Map(PHASES.map((p, i) => [p.phase, i]));
const PHASE_LABEL = new Map(PHASES.map((p) => [p.phase, p.label]));

/** Which group a difference belongs to: its ruleset phase for rules, else its kind. */
export function groupOf(d: { item: string; kind: IndexKind }): DiffGroup {
  const m = RULESET.exec(d.item);
  if (m) {
    const i = PHASE_INDEX.get(m[1]);
    return { key: `phase:${m[1]}`, label: PHASE_LABEL.get(m[1]) ?? `Ruleset ${m[1]}`, order: 100 + (i ?? 99) };
  }
  return { key: `kind:${d.kind}`, label: KIND_LABEL[d.kind] ?? d.kind, order: KIND_ORDER[d.kind] ?? 400 };
}

/** What a difference is, inside its group ("Rule 2 · action_parameters.origin.host", "The ruleset itself"). */
export function whatOf(d: { item: string; path: string }): string {
  const m = RULESET.exec(d.item);
  if (!m) return d.path;
  return m[2] ? `Rule ${m[2]} · ${m[3]}` : 'The ruleset itself';
}

/** The rule a difference belongs to (its position in the phase), or null. */
export function ruleOf(item: string): number | null {
  const m = RULESET.exec(item);
  return m?.[2] ? Number(m[2]) : null;
}

const natural = new Intl.Collator('en', { numeric: true }).compare;
/** Differences in group order, then by item (rule 2 before rule 10). */
export function sortDiffs<T extends { item: string; kind: IndexKind }>(list: T[]): T[] {
  return list.map((d) => ({ d, g: groupOf(d) })).sort((x, y) => x.g.order - y.g.order || x.g.key.localeCompare(y.g.key) || natural(x.d.item, y.d.item)).map((x) => x.d);
}

/** Each group's counts, in group order. */
export function groupCounts(list: { item: string; kind: IndexKind; status: ItemDiff['status'] }[]): GroupCount[] {
  const m = new Map<string, GroupCount>();
  for (const d of list) {
    const g = groupOf(d);
    const c = m.get(g.key) ?? { ...g, onlyA: 0, onlyB: 0, different: 0, total: 0 };
    if (d.status === 'only-a') c.onlyA++; else if (d.status === 'only-b') c.onlyB++; else c.different++;
    c.total++;
    m.set(g.key, c);
  }
  return [...m.values()].sort((x, y) => x.order - y.order || x.key.localeCompare(y.key));
}

// ── Report ──────────────────────────────────────────────────────────────────

export interface ZoneDiffReport {
  a: { id: string; name: string }; b: { id: string; name: string };
  diffs: ItemDiff[]; same: number; counts: { onlyA: number; onlyB: number; different: number };
  groups: GroupCount[]; generatedAt: string;
}

export const statusText = (s: ItemDiff['status'], r: { a: { name: string }; b: { name: string } }) => (s === 'different' ? 'Different' : `Only in ${s === 'only-a' ? r.a.name : r.b.name}`);
const val = (v: string[]) => v.join('\n');

/** A cell: quoted when needed, and a leading = + - @ made inert (a spreadsheet would run it). */
const csvCell = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) || safe !== v ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Every difference, one row each (UTF-8 with a BOM so Excel reads it right). */
export function zoneDiffCsv(r: ZoneDiffReport): string {
  const rows = [['Group', 'What', 'Item', 'Status', r.a.name, r.b.name],
    ...r.diffs.map((d) => [groupOf(d).label, whatOf(d), d.item, statusText(d.status, r), val(d.a), val(d.b)])];
  return `﻿${rows.map((x) => x.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (x: number) => x.toLocaleString('en-US');

/** A self-contained page (no scripts, no outside files) that prints well: summary, then each group. */
export function zoneDiffHtml(r: ZoneDiffReport, o: { brand: string; at: string }): string {
  const title = `${r.a.name} vs ${r.b.name}`;
  const byGroup = new Map<string, ItemDiff[]>();
  for (const d of r.diffs) { const k = groupOf(d).key; byGroup.set(k, [...(byGroup.get(k) ?? []), d]); }
  const cellOf = (v: string[]) => (v.length ? `<pre>${esc(val(v))}</pre>` : '<span class="none">—</span>');
  const summary = r.groups.map((g) => `<tr><td><a href="#${esc(g.key)}">${esc(g.label)}</a></td><td class="num">${n(g.different)}</td><td class="num">${n(g.onlyA)}</td><td class="num">${n(g.onlyB)}</td><td class="num">${n(g.total)}</td></tr>`).join('');
  const sections = r.groups.map((g) => `
<section id="${esc(g.key)}">
  <h2>${esc(g.label)} <small>${n(g.total)} difference${g.total === 1 ? '' : 's'}</small></h2>
  <table class="diff"><thead><tr><th>What</th><th>Status</th><th>${esc(r.a.name)}</th><th>${esc(r.b.name)}</th></tr></thead><tbody>
  ${(byGroup.get(g.key) ?? []).map((d) => `<tr><td>${esc(whatOf(d))}<div class="item">${esc(d.item)}</div></td><td><span class="st ${d.status}">${esc(statusText(d.status, r))}</span></td><td>${cellOf(d.a)}</td><td>${cellOf(d.b)}</td></tr>`).join('\n  ')}
  </tbody></table>
</section>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · zone comparison</title>
<style>
  :root { color-scheme: light; --ink: #1b2330; --muted: #5b6574; --line: #d9dee6; --navy: #1f3864; --bad: #b42318; --warn: #a15c07; }
  body { margin: 0; padding: 32px 16px; font: 14px/1.5 Arial, Helvetica, sans-serif; color: var(--ink); background: #fff; }
  main { max-width: 1100px; margin: 0 auto; }
  h1 { color: var(--navy); font-size: 24px; margin: 0 0 4px; overflow-wrap: anywhere; }
  h2 { color: var(--navy); font-size: 18px; margin: 32px 0 8px; break-after: avoid; }
  h2 small { color: var(--muted); font-size: 13px; font-weight: normal; margin-left: 8px; }
  .meta { color: var(--muted); margin: 0 0 20px; overflow-wrap: anywhere; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 16px 0 8px; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .card b { display: block; font-size: 22px; }
  .card span { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th { background: var(--navy); color: #fff; text-align: left; font-size: 12px; padding: 6px 8px; }
  td { border-bottom: 1px solid var(--line); padding: 6px 8px; vertical-align: top; overflow-wrap: anywhere; }
  tr { break-inside: avoid; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  table.summary { max-width: 720px; }
  table.summary th:not(:first-child) { text-align: right; }
  table.diff th:nth-child(1) { width: 26%; } table.diff th:nth-child(2) { width: 12%; }
  pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 Consolas, "Courier New", monospace; }
  .item { color: var(--muted); font: 11px Consolas, "Courier New", monospace; overflow-wrap: anywhere; margin-top: 2px; }
  .none { color: var(--muted); }
  .st { font-size: 12px; font-weight: bold; color: var(--warn); }
  .st.different { color: var(--bad); }
  a { color: var(--navy); }
  footer { margin-top: 40px; color: var(--muted); font-size: 12px; }
  @media print { body { padding: 0; } a { color: inherit; text-decoration: none; } }
</style></head>
<body><main>
<h1>${esc(title)}</h1>
<p class="meta">Zone comparison · ${esc(o.at)} · ${esc(o.brand)}<br>Zone A: ${esc(r.a.name)} (${esc(r.a.id)}) · Zone B: ${esc(r.b.name)} (${esc(r.b.id)})</p>
<div class="cards">
  <div class="card"><b>${n(r.counts.different)}</b><span>different values</span></div>
  <div class="card"><b>${n(r.counts.onlyA)}</b><span>only in ${esc(r.a.name)}</span></div>
  <div class="card"><b>${n(r.counts.onlyB)}</b><span>only in ${esc(r.b.name)}</span></div>
  <div class="card"><b>${n(r.same)}</b><span>the same</span></div>
</div>
<p class="meta">From each zone's stored configuration (its newest backup and drift snapshot). Each zone's own name is written as {zone}, so names that naturally differ do not count. Rules are compared by their position in the phase: rule 2 in one zone against rule 2 in the other.</p>
${r.diffs.length ? `<h2>Summary</h2>
<table class="summary"><thead><tr><th>Type</th><th>Different</th><th>Only in A</th><th>Only in B</th><th>Total</th></tr></thead><tbody>${summary}</tbody></table>
${sections}` : '<h2>No differences</h2><p>The two zones have the same stored configuration.</p>'}
<footer>Generated ${esc(o.at)}. Read-only: nothing was read from or written to Cloudflare to make this report.</footer>
</main></body></html>
`;
}
