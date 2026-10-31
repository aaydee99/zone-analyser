import 'server-only';
import crypto from 'node:crypto';
import { db, must } from './supabase';
import { HttpError } from './http';
import { assertPublicUrl, UnsafeUrlError } from './safe-url';
import { openRelay, sealRelay } from './vault';
import { CHECKS, SEVERITIES, isCheckId, type CheckId, type Severity } from './monitor-types';

// Monitoring settings, kept under `monitoring` in the settings row: whether the checks run on their
// own, how often each one runs, the lowest severity that is sent, where notifications go, and the
// secret Cloudflare's alert webhook signs with. The Slack and webhook URLs and that secret are sealed with the vault's server key;
// the browser only ever sees whether they are set and the end of the address.

interface Sealed { iv: string; tag: string; ct: string }
interface Stored {
  /** Before 0011: one interval for every check; 0 meant "only by hand". */
  intervalHours?: number;
  scheduled?: boolean;
  intervals?: Partial<Record<CheckId, number>>;
  minSeverity?: Severity;
  slack?: Sealed | null;
  webhook?: Sealed | null;
  inboxSecret?: Sealed | null;
  lastRunAt?: string | null;
}

export interface MonitorConfig { scheduled: boolean; intervals: Record<CheckId, number>; minSeverity: Severity; slack: string; webhook: string; inboxSecret: string }

/** What the browser sees. */
export interface MonitorConfigView {
  scheduled: boolean;
  /** Hours between runs of each check. */
  intervals: Record<CheckId, number>;
  minSeverity: Severity;
  slack: { set: boolean; hint: string };
  webhook: { set: boolean; hint: string };
  inbox: { set: boolean };
}

/** Hours between runs a check may be set to. */
export const MIN_HOURS = 0.25, MAX_HOURS = 168;
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
  const intervals = Object.fromEntries(CHECKS.map((c) => {
    const h = Number(m.intervals?.[c.id]);
    return [c.id, Number.isFinite(h) && h >= MIN_HOURS && h <= MAX_HOURS ? h : c.every];
  })) as Record<CheckId, number>;
  return {
    scheduled: m.scheduled ?? m.intervalHours !== 0,
    intervals,
    minSeverity: SEVERITIES.includes(m.minSeverity as Severity) ? m.minSeverity! : 'high',
    slack: await unseal(m.slack, 'slack'),
    webhook: await unseal(m.webhook, 'webhook'),
    inboxSecret: await unseal(m.inboxSecret, 'inbox'),
  };
}

const hint = (url: string) => (url ? `…${url.slice(-6)}` : '');

export async function monitorConfigView(): Promise<MonitorConfigView> {
  const c = await getMonitorConfig();
  return { scheduled: c.scheduled, intervals: c.intervals, minSeverity: c.minSeverity, slack: { set: !!c.slack, hint: hint(c.slack) }, webhook: { set: !!c.webhook, hint: hint(c.webhook) }, inbox: { set: !!c.inboxSecret } };
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
  const h = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || /^[\d.]+$/.test(h) || h.includes(':')) {
    throw new HttpError(400, `${label} must use a public host name, not an IP address or a local name`);
  }
  if (slackOnly && h !== 'hooks.slack.com') throw new HttpError(400, 'A Slack address starts with https://hooks.slack.com/');
  if (v.length > 2000) throw new HttpError(400, `${label} is too long`);
  return v;
}

/**
 * checkHookUrl, then where the name points: every address it resolves to must be public (a name
 * like 10.0.0.5.nip.io passes the name checks). Checked again at every send (src/lib/notify.ts).
 */
export async function checkHookAddress(raw: string, label: string, slackOnly = false): Promise<string> {
  const v = checkHookUrl(raw, label, slackOnly);
  try {
    await assertPublicUrl(v);
  } catch (err) {
    throw new HttpError(400, `${label} ${err instanceof UnsafeUrlError ? err.message : 'is not allowed'}`);
  }
  return v;
}

export interface MonitorConfigPatch { scheduled?: boolean; intervals?: Partial<Record<string, number>>; minSeverity?: Severity; slack?: string | null; webhook?: string | null }

export async function saveMonitorConfig(p: MonitorConfigPatch): Promise<MonitorConfigView> {
  await write(async (m) => {
    if (p.scheduled !== undefined) {
      if (typeof p.scheduled !== 'boolean') throw new HttpError(400, 'scheduled must be true or false');
      m.scheduled = p.scheduled;
      delete m.intervalHours;
    }
    if (p.intervals !== undefined) {
      if (!p.intervals || typeof p.intervals !== 'object') throw new HttpError(400, 'intervals must be an object of hours by check');
      const next = { ...(m.intervals ?? {}) };
      for (const [id, v] of Object.entries(p.intervals)) {
        if (!isCheckId(id)) throw new HttpError(400, `Unknown check: ${id}`);
        const h = Number(v);
        if (!Number.isFinite(h) || h < MIN_HOURS || h > MAX_HOURS) throw new HttpError(400, `Run each check every ${MIN_HOURS * 60} minutes to ${MAX_HOURS} hours`);
        next[id] = Math.round(h * 4) / 4;
      }
      m.intervals = next;
    }
    if (p.minSeverity !== undefined) {
      if (!SEVERITIES.includes(p.minSeverity)) throw new HttpError(400, 'Unknown severity');
      m.minSeverity = p.minSeverity;
    }
    if (p.slack !== undefined) m.slack = p.slack ? await sealRelay(Buffer.from(await checkHookAddress(p.slack, 'The Slack address', true)), AAD('slack')) : null;
    if (p.webhook !== undefined) m.webhook = p.webhook ? await sealRelay(Buffer.from(await checkHookAddress(p.webhook, 'The webhook address')), AAD('webhook')) : null;
  });
  return monitorConfigView();
}

/** The secret Cloudflare sends with each alert (cf-webhook-auth); made once, on first use. */
export async function inboxSecret(create: boolean): Promise<string> {
  const c = await getMonitorConfig();
  if (c.inboxSecret || !create) return c.inboxSecret;
  const secret = crypto.randomBytes(24).toString('base64url');
  await write(async (m) => { m.inboxSecret = await sealRelay(Buffer.from(secret), AAD('inbox')); });
  return secret;
}
