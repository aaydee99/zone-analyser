import 'server-only';
import { BRAND } from './brand';
import { getMonitorConfig } from './monitor-config';
import { claimForSending, logNotification, releaseClaim, saveDelivered, unsentFindings } from './monitor-store';
import { CHECK, SEVERITY_RANK, type Finding } from './monitor-types';
import { safePost } from './safe-url';

// Notifications about new findings, to Slack and/or a webhook. The worker sends what is new in one
// batch every few minutes while checks run, and once more when the queue is empty (sendUnsent).
// Each batch is claimed BEFORE it is sent (notified_at is set only where it was not, so of two
// workers only one sends a finding) and sent once per channel; the channels it reached are kept
// (notified_channels, 0012_monitor_claims.sql). A finding a channel failed for is given back and
// sent again, to that channel only, in a later round. Only findings at or above the configured
// severity, not dismissed and not notified before, are sent. A worker that stops between claiming
// and sending loses that batch (it is not sent twice).

const MAX_LINES = 25;

function lines(findings: Finding[]) {
  return findings.slice(0, MAX_LINES).map((f) => {
    const where = [f.accountName, f.zoneName].filter(Boolean).join(' › ');
    return `• [${f.severity.toUpperCase()}] ${CHECK[f.check]?.label ?? f.check}: ${f.title}${where ? ` (${where})` : ''}`;
  });
}

/**
 * Checked again at every send (src/lib/safe-url.ts): public HTTPS only, connected to the address
 * that was checked, no redirects. The error is generic (never a raw connection error).
 */
async function post(url: string, body: unknown, label = 'webhook'): Promise<{ ok: boolean; error: string | null }> {
  const r = await safePost(url, JSON.stringify(body), { timeoutMs: 15_000, label });
  return { ok: r.ok, error: r.error };
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

/** Open findings found within this long that were never sent are sent; older ones are not (no surprise backlog). */
const UNSENT_WINDOW_MS = 24 * 3_600_000;

/** Findings per message; more are sent as several messages. */
const BATCH = 500;
/** Messages per round at most (the rest waits for the next round). */
const MAX_BATCHES = 20;

/**
 * Sends every new finding worth sending that has not been sent, a batch at a time. Returns how many
 * were delivered, and whether a channel failed (the queue then waits a while before trying again).
 */
export async function sendUnsent(): Promise<{ sent: number; failed: boolean }> {
  const c = await getMonitorConfig();
  if (!c.slack && !c.webhook) return { sent: 0, failed: false };
  let sent = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const batch = await unsentFindings(SEVERITY_RANK[c.minSeverity], new Date(Date.now() - UNSENT_WINDOW_MS).toISOString(), BATCH);
    if (!batch.length) break;
    const r = await notifyFindings(batch);
    sent += r.sent;
    if (r.failed) return { sent, failed: true };
    if (batch.length < BATCH) break;
  }
  return { sent, failed: false };
}

/** Sends the findings worth sending, once per channel. Returns how many were delivered everywhere, and whether a channel failed. */
export async function notifyFindings(candidates: Finding[]): Promise<{ sent: number; failed: boolean }> {
  const c = await getMonitorConfig();
  const channels = ([['slack', c.slack], ['webhook', c.webhook]] as const).filter(([, url]) => !!url);
  if (!channels.length) return { sent: 0, failed: false };
  const wanted = candidates
    .filter((f) => !f.dismissedAt && !f.notifiedAt && SEVERITY_RANK[f.severity] >= SEVERITY_RANK[c.minSeverity])
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  if (!wanted.length) return { sent: 0, failed: false };
  // Claimed first: a finding another worker claimed (or sent) is left to it.
  const { at, won } = await claimForSending(wanted.map((f) => f.id));
  const findings = wanted.filter((f) => won.has(f.id));
  if (!findings.length) return { sent: 0, failed: false };
  let failed = false;
  for (const [channel, url] of channels) {
    // Only what this channel has not had yet (an earlier round may have reached the other one).
    const due = findings.filter((f) => !won.get(f.id)!.includes(channel));
    if (!due.length) continue;
    const subject = `${BRAND.name}: ${due.length} new finding${due.length === 1 ? '' : 's'}`;
    const r = await post(url, channel === 'slack' ? slackBody(subject, due, consoleUrl()) : webhookBody(subject, due, consoleUrl()), channel);
    await logNotification({ channel, subject, findings: due.length, ...r });
    if (r.ok) for (const f of due) won.get(f.id)!.push(channel);
    else failed = true;
  }
  await saveDelivered(new Map(findings.map((f) => [f.id, won.get(f.id)!])));
  // Not delivered everywhere: given back, so the next round sends it to the channels it missed.
  const missed = findings.filter((f) => channels.some(([ch]) => !won.get(f.id)!.includes(ch))).map((f) => f.id);
  if (missed.length) await releaseClaim(missed, at);
  return { sent: findings.length - missed.length, failed };
}

/** One test message to one channel, when someone asks for it. */
export async function sendTest(channel: 'slack' | 'webhook'): Promise<{ ok: boolean; error: string | null }> {
  const c = await getMonitorConfig();
  const url = channel === 'slack' ? c.slack : c.webhook;
  if (!url) return { ok: false, error: `No ${channel === 'slack' ? 'Slack' : 'webhook'} address is set` };
  const subject = `${BRAND.name}: test notification`;
  const r = channel === 'slack'
    ? await post(url, { text: `*${subject}*\nNotifications from ${BRAND.name} arrive here.` }, 'slack')
    : await post(url, { source: BRAND.name.toLowerCase(), event: 'test', subject, sentAt: new Date().toISOString(), findings: [] }, 'webhook');
  await logNotification({ channel, subject, findings: 0, ...r });
  return r;
}
