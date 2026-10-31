import 'server-only';
import { cfOne } from '../cf-read';
import type { NewFinding } from '../monitor-store';
import type { Row, Severity } from '../monitor-types';
import { SEV_SORT, notAvailable, readStat, severityStats, type CheckDef } from './common';

// Security posture: Cloudflare's Security Insights, per account (GET /accounts/{id}/security-center/insights).
// Cloudflare scans every 7 days (3 on Enterprise), so once a day is plenty; dismissed insights are left out.

interface Insight {
  id: string; issue_class?: string; issue_type?: string; severity?: string; subject?: string;
  since?: string; timestamp?: string; resolve_text?: string; resolve_link?: string; dismissed?: boolean;
}

const SEV: Record<string, Severity> = { critical: 'critical', high: 'high', moderate: 'medium', medium: 'medium', low: 'low' };
const label = (s?: string) => (s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const posture: CheckDef = {
  id: 'posture', main: 'account',
  units: {
    account: async (a, ctx) => {
      const rows: Row[] = [];
      const findings: NewFinding[] = [];
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
        for (const i of issues) {
          const severity = SEV[(i.severity ?? '').toLowerCase()] ?? 'low';
          rows.push({
            severity, account: a.accountName || a.accountId, subject: i.subject ?? '', issue: label(i.issue_type), class: label(i.issue_class),
            since: i.since ?? i.timestamp ?? null, fix: i.resolve_text ?? '', link: i.resolve_link ?? null, _sort: SEV_SORT[severity],
          });
          findings.push({
            key: `${a.accountId}:${i.id}`, severity, title: `${label(i.issue_type) || 'Security issue'}${i.subject ? `: ${i.subject}` : ''}`,
            detail: i.resolve_text ?? '', accountId: a.accountId, accountName: a.accountName,
          });
        }
        return { rows: { insights: rows }, findings, counts: { insights: rows.length }, complete: true };
      } catch (err) {
        if (!notAvailable(err)) throw err;
        throw new Error(`${err instanceof Error ? err.message : String(err)} (the token needs Account Settings Read, and Security Center must be available to the account)`);
      }
    },
  },
  sections: [{
    key: 'insights', title: 'Security insights', description: 'From Cloudflare’s Security Center. Fix them in the Cloudflare dashboard, or dismiss them there if they are expected.',
    columns: [{ key: 'severity', label: 'Severity', kind: 'severity' }, { key: 'issue', label: 'Issue' }, { key: 'subject', label: 'Subject', kind: 'mono' }, { key: 'account', label: 'Account' }, { key: 'since', label: 'Since', kind: 'date' }, { key: 'fix', label: 'How to fix' }, { key: 'link', label: '', kind: 'link' }],
    empty: 'No open insights — Cloudflare found nothing to fix in the accounts it read.',
  }],
  stats: (t) => [{ label: 'Open insights', value: t.counts.insights ?? 0, tone: t.counts.insights ? 'warn' : 'ok' }, ...severityStats(t.open).slice(0, 2), readStat(t, 'Accounts read')],
};
