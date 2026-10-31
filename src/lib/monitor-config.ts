import 'server-only';
import crypto from 'node:crypto';
import { db, must } from './supabase';
import { HttpError } from './http';
import { openRelay, sealRelay } from './vault';
import { SEVERITIES, type Severity } from './monitor-types';

// Monitoring settings, kept under `monitoring` in the settings row: how often the checks run, the
// lowest severity that is sent, where notifications go, and the secret Cloudflare's alert webhook
// signs with. The Slack and webhook URLs and that secret are sealed with the vault's server key;
// the browser only ever sees whether they are set and the end of the address.

interface Sealed { iv: string; tag: string; ct: string }
interface Stored {
  intervalHours?: number;
  minSeverity?: Severity;
  slack?: Sealed | null;
  webhook?: Sealed | null;
  inboxSecret?: Sealed | null;
  lastRunAt?: string | null;
}

export interface MonitorConfig { intervalHours: number; minSeverity: Severity; slack: string; webhook: string; inboxSecret: string; lastRunAt: string | null }

/** What the browser sees. */
export interface MonitorConfigView {
  intervalHours: number;
  minSeverity: Severity;
  slack: { set: boolean; hint: string };
  webhook: { set: boolean; hint: string };
  inbox: { set: boolean };
}

export const DEFAULT_INTERVAL_HOURS = 6;
const AAD = (k: string) => `monitoring:${k}`;

async function readRow(): Promise<{ data: Record<string, unknown> }> {
  const row = must(await db().from('settings').select('data').eq('id', 1).maybeSingle(), 'Reading settings') as { data?: Record<string, unknown> } | null;
  return { data: row?.data ?? {} };
}

const unseal = async (s: Sealed | null | undefined, k: string) => {
  if (!s) return '';
  try { return (await openRelay(s, AAD(k))).toString('utf8'); } catch { return ''; }
};

export async function getMonitorConfig(): Promise<MonitorConfig> {
  const m = ((await readRow()).data.monitoring ?? {}) as Stored;
  const hours = Number(m.intervalHours);
  return {
    intervalHours: Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_INTERVAL_HOURS,
    minSeverity: SEVERITIES.includes(m.minSeverity as Severity) ? m.minSeverity! : 'high',
    slack: await unseal(m.slack, 'slack'),
    webhook: await unseal(m.webhook, 'webhook'),
    inboxSecret: await unseal(m.inboxSecret, 'inbox'),
    lastRunAt: m.lastRunAt ?? null,
  };
}

const hint = (url: string) => (url ? `…${url.slice(-6)}` : '');

export async function monitorConfigView(): Promise<MonitorConfigView> {
  const c = await getMonitorConfig();
  return { intervalHours: c.intervalHours, minSeverity: c.minSeverity, slack: { set: !!c.slack, hint: hint(c.slack) }, webhook: { set: !!c.webhook, hint: hint(c.webhook) }, inbox: { set: !!c.inboxSecret } };
}

async function write(change: (m: Stored) => Promise<void> | void) {
  const { data } = await readRow();
  const m = { ...((data.monitoring ?? {}) as Stored) };
  await change(m);
  must(await db().from('settings').upsert({ id: 1, data: { ...data, monitoring: m }, updated_at: new Date().toISOString() }), 'Saving monitoring settings');
}

/** Only public HTTPS addresses: notifications must never reach the worker's own network. */
export function checkHookUrl(raw: string, label: string, slackOnly = false): string {
  const v = raw.trim();
  let u: URL;
  try { u = new URL(v); } catch { throw new HttpError(400, `${label} must be a full https:// address`); }
  if (u.protocol !== 'https:') throw new HttpError(400, `${label} must start with https://`);
  if (u.username || u.password) throw new HttpError(400, `${label} must not contain a user name or password`);
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || /^[\d.]+$/.test(h) || h.includes(':')) {
    throw new HttpError(400, `${label} must use a public host name, not an IP address or a local name`);
  }
  if (slackOnly && h !== 'hooks.slack.com') throw new HttpError(400, 'A Slack address starts with https://hooks.slack.com/');
  if (v.length > 2000) throw new HttpError(400, `${label} is too long`);
  return v;
}

export interface MonitorConfigPatch { intervalHours?: number; minSeverity?: Severity; slack?: string | null; webhook?: string | null }

export async function saveMonitorConfig(p: MonitorConfigPatch): Promise<MonitorConfigView> {
  await write(async (m) => {
    if (p.intervalHours !== undefined) {
      const h = Number(p.intervalHours);
      if (!Number.isFinite(h) || h < 0 || h > 168) throw new HttpError(400, 'Run checks every 0 (off) to 168 hours');
      m.intervalHours = Math.round(h * 4) / 4;
    }
    if (p.minSeverity !== undefined) {
      if (!SEVERITIES.includes(p.minSeverity)) throw new HttpError(400, 'Unknown severity');
      m.minSeverity = p.minSeverity;
    }
    if (p.slack !== undefined) m.slack = p.slack ? await sealRelay(Buffer.from(checkHookUrl(p.slack, 'The Slack address', true)), AAD('slack')) : null;
    if (p.webhook !== undefined) m.webhook = p.webhook ? await sealRelay(Buffer.from(checkHookUrl(p.webhook, 'The webhook address')), AAD('webhook')) : null;
  });
  return monitorConfigView();
}

export async function setLastRun(at: string) {
  await write((m) => { m.lastRunAt = at; });
}

/** The secret Cloudflare sends with each alert (cf-webhook-auth); made once, on first use. */
export async function inboxSecret(create: boolean): Promise<string> {
  const c = await getMonitorConfig();
  if (c.inboxSecret || !create) return c.inboxSecret;
  const secret = crypto.randomBytes(24).toString('base64url');
  await write(async (m) => { m.inboxSecret = await sealRelay(Buffer.from(secret), AAD('inbox')); });
  return secret;
}
