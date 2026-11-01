// Scheduled reports as text: the Slack message, the webhook body, the HTML download and one CSV per
// section. Shared by server and client — no Node imports. Every value is escaped for where it goes.

import { SEVERITIES } from './monitor-types';
import { csvFile } from './zone-format';
import {
  SECTION_LABEL, bytesLabel, changeLabel, fmtEastern, sumCounts,
  type ReportContent, type SectionKey, type SevCounts, type TrafficNumbers,
} from './report-types';

import { compactNum as whole } from '@/lib/num';
const day = (iso: string) => fmtEastern(iso);
export const periodLabel = (c: Pick<ReportContent, 'periodStart' | 'periodEnd'>) => `${day(c.periodStart)} – ${day(c.periodEnd)}`;
const sevLine = (c: SevCounts) => SEVERITIES.filter((s) => c[s]).map((s) => `${c[s]} ${s}`).join(', ') || 'none';
const pct = (part: number, total: number) => (total ? `${((part / total) * 100).toFixed(1)}%` : '—');

/** Each section's lines of plain text (Slack and the console's summary use these). */
export function sectionLines(c: ReportContent, key: SectionKey): string[] {
  const s = c.sections;
  const why = (x: { status: string; note?: string } | undefined) => (x?.status === 'unavailable' ? [`Not available: ${x.note ?? 'could not be read'}`] : null);
  switch (key) {
    case 'changes': {
      const x = s.changes;
      if (!x) return [];
      const no = why(x); if (no) return no;
      if (!x.total && !x.zoneEvents.added && !x.zoneEvents.removed) return ['Nothing changed.', ...x.problems.map((p) => `Not read: ${p.account} (${p.error})`)];
      return [
        `${whole(x.total)} change${x.total === 1 ? '' : 's'}: ${x.byCategory.map((g) => `${g.label} ${whole(g.total)}`).join(', ') || '—'}`,
        ...(x.zoneEvents.added || x.zoneEvents.activated || x.zoneEvents.removed ? [`Zones: ${whole(x.zoneEvents.added)} added, ${x.zoneEvents.activated} activated, ${whole(x.zoneEvents.removed)} removed`] : []),
        ...x.problems.slice(0, 5).map((p) => `Not read: ${p.account} (${p.error})`),
      ];
    }
    case 'findings': {
      const x = s.findings;
      if (!x) return [];
      const no = why(x); if (no) return no;
      return [
        `Open: ${sumCounts(x.open)} (${sevLine(x.open)})`,
        `New since the last report: ${sumCounts(x.fresh)} (${sevLine(x.fresh)})`,
        `Resolved since the last report: ${sumCounts(x.resolved)}`,
      ];
    }
    case 'traffic': {
      const x = s.traffic;
      if (!x) return [];
      const no = why(x); if (no) return no;
      if (!x.current) return ['Nothing read.'];
      const t = x.current, p = x.previous;
      const lines = [
        `Requests ${whole(t.requests)} (${changeLabel(t.requests, p?.requests) || 'no earlier period'}) · cached ${pct(t.cachedRequests, t.requests)}`,
        `Bandwidth ${bytesLabel(t.bytes)} (${changeLabel(t.bytes, p?.bytes) || 'no earlier period'})`,
      ];
      if (x.security) lines.push(`Security events ${whole(x.security.events)} (${changeLabel(x.security.events, x.securityPrevious?.events) || 'no earlier period'})${x.security.byAction.length ? `: ${x.security.byAction.slice(0, 4).map((a) => `${a.action} ${whole(a.count)}`).join(', ')}` : ''}`);
      lines.push(`${whole(x.read)} of ${x.of} ${x.unit} read${x.problems.length ? ` · ${whole(x.problems.length)} not read` : ''}`);
      return lines;
    }
    case 'certificates': {
      const x = s.certificates;
      if (!x) return [];
      const no = why(x); if (no) return no;
      if (!x.total) return ['Nothing expires within 30 days.'];
      return [`${whole(x.total)} certificate${x.total === 1 ? '' : 's'} expired or expiring within 30 days`, ...x.rows.slice(0, 5).map((r) => `${r.days !== null && r.days < 0 ? 'Expired' : `${r.days} days`}: ${r.name} (${r.where})`)];
    }
    case 'coverage': {
      const x = s.coverage;
      if (!x) return [];
      const no = why(x); if (no) return no;
      const bad = x.checks.filter((k) => k.failing || k.never);
      if (!bad.length) return ['Nothing: every unit was read.'];
      return bad.map((k) => `${k.label}: ${whole(k.failing)} failing, ${k.never} never read (of ${whole(k.targets)})`);
    }
  }
}

const present = (c: ReportContent) => (Object.keys(SECTION_LABEL) as SectionKey[]).filter((k) => c.sections[k]);

// ── Slack ───────────────────────────────────────────────────────────────────

/** Slack's mrkdwn: &, < and > are escaped; nothing else is special in plain text. */
export const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One Slack message (incoming webhook): the period, then each section in a few lines. */
export function slackMessage(c: ReportContent, brand: string, link: string | null): { text: string } {
  const head = `*${slackEscape(`${brand} report: ${c.name}`)}*\n${slackEscape(`${c.scope.label} · ${periodLabel(c)}`)}`;
  const body = present(c).map((k) => `*${slackEscape(SECTION_LABEL[k])}*\n${sectionLines(c, k).map((l) => `• ${slackEscape(l)}`).join('\n')}`).join('\n\n');
  return { text: `${head}\n\n${body}${link ? `\n\n<${link}|Open the report>` : ''}`.slice(0, 39_000) };
}

/** The webhook's JSON: the whole report. */
export const webhookMessage = (c: ReportContent, brand: string, link: string | null) => ({
  source: brand.toLowerCase(), event: 'report', subject: `${brand} report: ${c.name}`, sentAt: new Date().toISOString(), ...(link ? { url: link } : {}), report: c,
});

// ── HTML download ───────────────────────────────────────────────────────────

const h = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const table = (head: string[], rows: unknown[][]) => rows.length
  ? `<table><thead><tr>${head.map((x) => `<th>${h(x)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((x) => `<td>${h(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  : '<p class="muted">Nothing.</p>';
const nums = (t: TrafficNumbers | null) => (t ? [whole(t.requests), whole(t.cachedRequests), bytesLabel(t.bytes), bytesLabel(t.cachedBytes), whole(t.pageViews)] : ['—', '—', '—', '—', '—']);

/** A standalone HTML file (no scripts, no outside resources). */
export function reportHtml(c: ReportContent, brand: string): string {
  const parts: string[] = [];
  for (const k of present(c)) {
    parts.push(`<h2>${h(SECTION_LABEL[k])}</h2>`);
    parts.push(`<ul>${sectionLines(c, k).map((l) => `<li>${h(l)}</li>`).join('')}</ul>`);
    const s = c.sections;
    if (k === 'changes' && s.changes?.status === 'ok') {
      parts.push(table(['Category', 'Changes', 'Created', 'Updated', 'Deleted'], s.changes.byCategory.map((g) => [g.label, g.total, g.create, g.update, g.delete])));
      parts.push('<h3>Newest changes</h3>', table(['Time (Eastern)', 'Change', 'Zone', 'Account', 'By'], s.changes.top.map((x) => [day(x.time), x.title, x.zone, x.account, x.actor])));
    }
    if (k === 'findings' && s.findings && s.findings.status !== 'unavailable') {
      parts.push(table(['Severity', 'Open', 'New', 'Resolved'], SEVERITIES.map((v) => [v, s.findings!.open[v], s.findings!.fresh[v], s.findings!.resolved[v]])));
      parts.push('<h3>New findings</h3>', table(['Severity', 'Check', 'Finding', 'Where', 'First seen (Eastern)'], s.findings.freshTop.map((f) => [f.severity, f.check, f.title, f.where, day(f.at)])));
      parts.push('<h3>Resolved findings</h3>', table(['Severity', 'Check', 'Finding', 'Where', 'Resolved (Eastern)'], s.findings.resolvedTop.map((f) => [f.severity, f.check, f.title, f.where, day(f.at)])));
    }
    if (k === 'traffic' && s.traffic?.current) {
      parts.push(table(['Period', 'Requests', 'Cached requests', 'Bandwidth', 'Cached bandwidth', 'Page views'], [['This period', ...nums(s.traffic.current)], ['Period before', ...nums(s.traffic.previous)]]));
      if (s.traffic.security) parts.push('<h3>Security events by action</h3>', table(['Action', 'Events'], s.traffic.security.byAction.map((a) => [a.action, whole(a.count)])));
      if (s.traffic.problems.length) parts.push('<h3>Not read</h3>', table(['Scope', 'Reason'], s.traffic.problems.map((p) => [p.scope, p.error])));
    }
    if (k === 'certificates' && s.certificates?.total) {
      parts.push(table(['Kind', 'Hosts / name', 'Zone or account', 'Status', 'Expires', 'Days left'], s.certificates.rows.map((r) => [r.kind, r.name, r.where, r.status, r.expires?.slice(0, 10) ?? '', r.days ?? ''])));
    }
    if (k === 'coverage' && s.coverage && s.coverage.status !== 'unavailable') {
      parts.push(table(['Check', 'Units', 'Read', 'Failing', 'Never read'], s.coverage.checks.map((x) => [x.label, x.targets, x.read, x.failing, x.never])));
      if (s.coverage.problems.length) parts.push('<h3>Newest failed reads</h3>', table(['Check', 'Where', 'Reason', 'When (Eastern)'], s.coverage.problems.map((p) => [p.check, p.scope, p.error, p.at ? day(p.at) : ''])));
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h(`${brand} report: ${c.name}`)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#1d232b;background:#fff;max-width:960px;margin:24px auto;padding:0 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 6px;border-bottom:1px solid #dde2e8;padding-bottom:4px}h3{font-size:14px;margin:16px 0 6px}table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px}th,td{text-align:left;border-bottom:1px solid #e8ecf0;padding:4px 8px;vertical-align:top}th{background:#f4f6f8}.muted{color:#5b6672}</style></head>
<body><h1>${h(c.name)}</h1><p class="muted">${h(c.scope.label)} · ${h(periodLabel(c))} · made ${h(day(c.generatedAt))}</p>${parts.join('\n')}</body></html>`;
}

// ── CSV per section ─────────────────────────────────────────────────────────

/** One section as CSV (null when the report has no such section). */
export function sectionCsv(c: ReportContent, key: SectionKey): string | null {
  const s = c.sections;
  switch (key) {
    case 'changes':
      if (!s.changes) return null;
      return csvFile([['Time (Eastern)', 'Change', 'Zone', 'Account', 'By'], ...s.changes.top.map((x) => [day(x.time), x.title, x.zone, x.account, x.actor])]);
    case 'findings':
      if (!s.findings) return null;
      return csvFile([['Kind', 'Severity', 'Check', 'Finding', 'Where', 'Time (Eastern)'],
        ...SEVERITIES.flatMap((v) => [['open (count)', v, '', String(s.findings!.open[v]), '', ''], ['new (count)', v, '', String(s.findings!.fresh[v]), '', ''], ['resolved (count)', v, '', String(s.findings!.resolved[v]), '', '']]),
        ...s.findings.freshTop.map((f) => ['new', f.severity, f.check, f.title, f.where, day(f.at)]),
        ...s.findings.resolvedTop.map((f) => ['resolved', f.severity, f.check, f.title, f.where, f.at])]);
    case 'traffic': {
      if (!s.traffic) return null;
      const t = s.traffic;
      const row = (label: string, n: TrafficNumbers | null, sec: typeof t.security) => [label, n?.requests ?? '', n?.cachedRequests ?? '', n?.bytes ?? '', n?.cachedBytes ?? '', n?.pageViews ?? '', sec?.events ?? ''];
      return csvFile([['Period', 'Requests', 'Cached requests', 'Bytes', 'Cached bytes', 'Page views', 'Security events'], row('this period', t.current, t.security), row('period before', t.previous, t.securityPrevious),
        ...(t.security?.byAction ?? []).map((a) => [`action: ${a.action}`, '', '', '', '', '', a.count]), ...t.problems.map((p) => [`not read: ${p.scope}`, p.error])]);
    }
    case 'certificates':
      if (!s.certificates) return null;
      return csvFile([['Kind', 'Hosts / name', 'Zone or account', 'Status', 'Expires', 'Days left'], ...s.certificates.rows.map((r) => [r.kind, r.name, r.where, r.status, r.expires ?? '', r.days ?? ''])]);
    case 'coverage':
      if (!s.coverage) return null;
      return csvFile([['Check', 'Units', 'Read', 'Failing', 'Never read', 'Problem scope', 'Problem', 'When (Eastern)'],
        ...s.coverage.checks.map((x) => [x.label, x.targets, x.read, x.failing, x.never, '', '', '']),
        ...s.coverage.problems.map((p) => [p.check, '', '', '', '', p.scope, p.error, p.at ? day(p.at) : ''])]);
  }
}
