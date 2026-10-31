import crypto from 'node:crypto';

// Slack request signing (https://api.slack.com/authentication/verifying-requests-from-slack):
// X-Slack-Signature is "v0=" + hex HMAC-SHA256 of "v0:<X-Slack-Request-Timestamp>:<raw body>" with
// the app's signing secret. A request older (or newer) than five minutes is refused, so a captured
// request cannot be replayed later; the console also accepts each signature only once.

export const MAX_SKEW_S = 5 * 60;

export type SlackCheck = { ok: true } | { ok: false; why: 'missing' | 'stale' | 'mismatch' };

/** Checks a request's signature against the signing secret. Constant time; nothing about the secret leaks. */
export function verifySlack(secret: string, timestamp: string | null, signature: string | null, body: string, nowS = Math.floor(Date.now() / 1000)): SlackCheck {
  if (!secret || !timestamp || !signature) return { ok: false, why: 'missing' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, why: 'stale' };
  if (Math.abs(nowS - Number(timestamp)) > MAX_SKEW_S) return { ok: false, why: 'stale' };
  const want = Buffer.from(`v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`);
  const got = Buffer.from(signature.trim());
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, why: 'mismatch' };
  return { ok: true };
}

/** The signature Slack would send (for tests and the e2e script). */
export const signSlack = (secret: string, timestamp: string, body: string) => `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;

export interface SlashCommand { command: string; text: string; userId: string; userName: string; teamId: string; responseUrl: string; channelId: string }

/** The fields of a slash command (application/x-www-form-urlencoded). */
export function parseSlashCommand(body: string): SlashCommand {
  const p = new URLSearchParams(body);
  const g = (k: string) => (p.get(k) ?? '').slice(0, 2000);
  return { command: g('command'), text: g('text').trim(), userId: g('user_id'), userName: g('user_name'), teamId: g('team_id'), responseUrl: g('response_url'), channelId: g('channel_id') };
}

/** Only Slack's own response addresses (https://hooks.slack.com/commands/… or /actions/…), nothing else is ever posted to. */
export function isSlackResponseUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  return u.protocol === 'https:' && u.hostname === 'hooks.slack.com' && !u.port && !u.username && !u.password && /^\/(commands|actions)\//.test(u.pathname);
}
