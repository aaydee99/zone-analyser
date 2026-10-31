import 'server-only';
import { HttpError } from './http';

// CAPTCHA on the public forms (sign-in, first-run setup) with Cloudflare Turnstile. On when both
// TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set; then every submission must carry a token
// that Cloudflare confirms, checked here on the server (the browser widget alone proves nothing).

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The public site key for the browser widget, or null when CAPTCHA is off. */
export function captchaSiteKey(): string | null {
  return process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY ? process.env.TURNSTILE_SITE_KEY : null;
}

/**
 * A setup warning when the sign-in form is on the open internet (Vercel) without CAPTCHA, else null.
 * Not enforced: turning Turnstile on is a hosting decision (README, CAPTCHA).
 */
export function captchaWarning(): string | null {
  if (!process.env.VERCEL || captchaSiteKey()) return null;
  return 'CAPTCHA is off on a public deployment: set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY (Cloudflare Turnstile) so sign-in and setup cannot be guessed at automatically';
}

/** Refuses the request unless Cloudflare confirms the Turnstile token (no-op while CAPTCHA is off). */
export async function requireCaptcha(token: unknown, remoteIp?: string) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret || !captchaSiteKey()) return;
  if (typeof token !== 'string' || !token || token.length > 2048) throw new HttpError(400, 'Complete the CAPTCHA check first');
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp && remoteIp !== 'direct') body.set('remoteip', remoteIp);
  let result: { success?: boolean; 'error-codes'?: string[] } | null;
  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(10_000), cache: 'no-store' });
    result = (await res.json()) as typeof result;
  } catch {
    throw new HttpError(503, 'Could not reach Cloudflare to check the CAPTCHA — try again');
  }
  if (result?.success !== true) throw new HttpError(400, 'The CAPTCHA check failed — try again');
}
