import 'server-only';
import { cfOne } from '../cf-read';
import type { NewFinding } from '../monitor-store';
import type { Row, Severity } from '../monitor-types';
import { Problems, notAvailable, report, severityStats, type CheckRunner } from './common';

// Security posture: Cloudflare's Security Insights, per account (GET /accounts/{id}/security-center/insights).
// Cloudflare scans every 7 days (3 on Enterprise); dismissed insights are left out.

interface Insight {
  id: string; issue_class?: string; issue_type?: string; severity?: string; subject?: string;
  since?: string; timestamp?: string; resolve_text?: string; resolve_link?: string; dismissed?: boolean;
}

const SEV: Record<string, Severity> = { critical: 'critical', high: 'high', moderate: 'medium', medium: 'medium', low: 'low' };
const label = (s?: string) => (s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const posture: CheckRunner = async (ctx) => {
  const started = Date.now();
  const p = new Problems();
  const { accounts, problems } = await ctx.accounts();
  p.list.push(...problems);
  const rows: Row[] = [];
  const findings: NewFinding[] = [];
  const read = new Set<string>();
  let unavailable = 0;
  ctx.progress.total = accounts.length;
  for (const a of accounts) {
    try {
      // Cloudflare answers { count, issues: [...], page, per_page } in `result`.
      const issues: Insight[] = [];
      for (let pg = 1; pg <= 20; pg++) {
        const res = await cfOne<{ issues?: Insight[]; count?: number } | Insight[]>(a.token, `/accounts/${a.accountId}/security-center/insights?dismissed=false&per_page=1000&page=${pg}`, ctx.signal);
        const got = Array.isArray(res) ? res : res?.issues ?? [];
        issues.push(...got.filter((i) => i && i.id && !i.dismissed));
        const total = Array.isArray(res) ? got.length : res?.count ?? got.length;
        if (got.length < 1000 || issues.length >= total) break;
      }
      read.add(a.accountId);
      for (const i of issues) {
        const severity = SEV[(i.severity ?? '').toLowerCase()] ?? 'low';
        rows.push({
          severity, account: a.accountName || a.accountId, subject: i.subject ?? '', issue: label(i.issue_type), class: label(i.issue_class),
          since: i.since ?? i.timestamp ?? null, fix: i.resolve_text ?? '', link: i.resolve_link ?? null,
        });
        findings.push({
          key: `${a.accountId}:${i.id}`, severity, title: `${label(i.issue_type) || 'Security issue'}${i.subject ? `: ${i.subject}` : ''}`,
          detail: i.resolve_text ?? '', accountId: a.accountId, accountName: a.accountName,
        });
      }
    } catch (err) {
      if (notAvailable(err)) unavailable++;
      p.add(a.accountName || a.accountId, err);
    }
    ctx.progress.done++;
  }
  rows.sort((x, y) => ['critical', 'high', 'medium', 'low', 'info'].indexOf(String(x.severity)) - ['critical', 'high', 'medium', 'low', 'info'].indexOf(String(y.severity)));
  return {
    report: report('posture', started, [{ label: 'Open insights', value: rows.length, tone: rows.length ? 'warn' : 'ok' }, ...severityStats(findings), { label: 'Accounts read', value: `${read.size} of ${accounts.length}` }], [{
      key: 'insights', title: 'Security insights',
      description: unavailable ? `${unavailable} account${unavailable === 1 ? '' : 's'} could not be read: the token needs Account Settings Read, and Security Center must be available to the account.` : 'From Cloudflare’s Security Center. Fix them in the Cloudflare dashboard, or dismiss them there if they are expected.',
      columns: [{ key: 'severity', label: 'Severity', kind: 'severity' }, { key: 'issue', label: 'Issue' }, { key: 'subject', label: 'Subject', kind: 'mono' }, { key: 'account', label: 'Account' }, { key: 'since', label: 'Since', kind: 'date' }, { key: 'fix', label: 'How to fix' }, { key: 'link', label: '', kind: 'link' }],
      rows, empty: 'No open insights — Cloudflare found nothing to fix in the accounts it read.',
    }], p.list, p.partial),
    findings, read,
  };
};
