import 'server-only';
import { BRAND } from './brand';
import { getMonitorConfig } from './monitor-config';
import { logNotification, markNotified } from './monitor-store';
import { CHECK, SEVERITY_RANK, type Finding } from './monitor-types';

// Notifications about new findings, to Slack and/or a webhook. Each batch is marked as notified
// BEFORE it is sent and sent once per channel: a failed send is logged, never retried, so nobody
// gets the same alert twice. Only findings at or above the configured severity, not dismissed and
// not notified before, are sent.

const MAX_LINES = 25;

function lines(findings: Finding[]) {
  return findings.slice(0, MAX_LINES).map((f) => {
    const where = [f.accountName, f.zoneName].filter(Boolean).join(' › ');
    return `• [${f.severity.toUpperCase()}] ${CHECK[f.check]?.label ?? f.check}: ${f.title}${where ? ` (${where})` : ''}`;
  });
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; error: string | null }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(15_000), cache: 'no-store' });
    if (res.ok) return { ok: true, error: null };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not reach the address' };
  }
}

function slackBody(subject: string, findings: Finding[], consoleUrl: string | null) {
  const more = findings.length > MAX_LINES ? `\n…and ${findings.length - MAX_LINES} more` : '';
  const link = consoleUrl ? `\n<${consoleUrl}/console/monitoring|Open ${BRAND.name}>` : '';
  return { text: `*${subject}*\n${lines(findings).join('\n')}${more}${link}` };
}

function webhookBody(subject: string, findings: Finding[], consoleUrl: string | null) {
  return {
    source: BRAND.name.toLowerCase(), event: 'findings', subject, sentAt: new Date().toISOString(),
    ...(consoleUrl ? { url: `${consoleUrl}/console/monitoring` } : {}),
    findings: findings.map((f) => ({ id: f.id, check: f.check, severity: f.severity, title: f.title, detail: f.detail, account: f.accountName, zone: f.zoneName, firstSeen: f.firstSeen })),
  };
}

const consoleUrl = () => (process.env.CONSOLE_PUBLIC_URL || '').replace(/\/+$/, '') || null;

/** Sends the findings worth sending, once. Returns how many were sent. */
export async function notifyFindings(candidates: Finding[]): Promise<number> {
  const c = await getMonitorConfig();
  if (!c.slack && !c.webhook) return 0;
  const findings = candidates
    .filter((f) => !f.dismissedAt && !f.notifiedAt && SEVERITY_RANK[f.severity] >= SEVERITY_RANK[c.minSeverity])
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  if (!findings.length) return 0;
  // Marked first: if the process stops halfway, the batch is never sent twice.
  await markNotified(findings.map((f) => f.id));
  const subject = `${BRAND.name}: ${findings.length} new finding${findings.length === 1 ? '' : 's'}`;
  if (c.slack) {
    const r = await post(c.slack, slackBody(subject, findings, consoleUrl()));
    await logNotification({ channel: 'slack', subject, findings: findings.length, ...r });
  }
  if (c.webhook) {
    const r = await post(c.webhook, webhookBody(subject, findings, consoleUrl()));
    await logNotification({ channel: 'webhook', subject, findings: findings.length, ...r });
  }
  return findings.length;
}

/** One test message to one channel, when someone asks for it. */
export async function sendTest(channel: 'slack' | 'webhook'): Promise<{ ok: boolean; error: string | null }> {
  const c = await getMonitorConfig();
  const url = channel === 'slack' ? c.slack : c.webhook;
  if (!url) return { ok: false, error: `No ${channel === 'slack' ? 'Slack' : 'webhook'} address is set` };
  const subject = `${BRAND.name}: test notification`;
  const r = channel === 'slack'
    ? await post(url, { text: `*${subject}*\nNotifications from ${BRAND.name} arrive here.` })
    : await post(url, { source: BRAND.name.toLowerCase(), event: 'test', subject, sentAt: new Date().toISOString(), findings: [] });
  await logNotification({ channel, subject, findings: 0, ...r });
  return r;
}
