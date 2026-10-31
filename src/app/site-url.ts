import 'server-only';
import { headers } from 'next/headers';

/**
 * The site's own origin for robots.txt and the sitemap: CONSOLE_PUBLIC_URL when set, else the
 * host this request came in on (the proxy has already refused hosts not in CONSOLE_ALLOWED_HOSTS).
 */
export async function siteOrigin(): Promise<string> {
  try { if (process.env.CONSOLE_PUBLIC_URL) return new URL(process.env.CONSOLE_PUBLIC_URL).origin; } catch { /* fall through */ }
  const h = await headers();
  const raw = h.get('host') ?? '';
  // Only a plain host[:port] goes into the files (never header text that could add lines).
  const host = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:]+\](:\d{1,5})?$/.test(raw) ? raw : '127.0.0.1:4400';
  const fwd = h.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const proto = (fwd === 'http' || fwd === 'https' ? fwd : '') || (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}
