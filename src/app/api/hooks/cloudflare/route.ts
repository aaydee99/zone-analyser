import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { clientKey, rateLimit, HttpError } from '@/lib/http';
import { isAllowedHost } from '@/lib/hosts';
import { inboxSecret } from '@/lib/monitor-config';
import { saveAlert } from '@/lib/monitor-store';

export const dynamic = 'force-dynamic';

const MAX_BODY = 256 * 1024;

const same = (a: string, b: string) => {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y) && a.length === b.length;
};

/**
 * Cloudflare's notification webhook (set up from Monitoring › Cloudflare alerts). No session: the
 * request must carry the secret the console gave Cloudflare, in cf-webhook-auth. Cloudflare sends no
 * Origin header, so this route checks the secret instead of the origin. Answers nothing but ok.
 */
export async function POST(req: Request) {
  try {
    if (!isAllowedHost(req.headers.get('host'))) throw new HttpError(403, 'Host not allowed');
    rateLimit(`hook:${clientKey(req)}`, 120);
    const secret = await inboxSecret(false);
    const given = req.headers.get('cf-webhook-auth') ?? '';
    if (!secret || !given || !same(given, secret)) throw new HttpError(401, 'Not authorised');
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) throw new HttpError(413, 'Too large');
    const text = await req.text();
    if (text.length > MAX_BODY) throw new HttpError(413, 'Too large');
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text) as Record<string, unknown>; } catch { data = { text }; }
    const s = (k: string) => (typeof data[k] === 'string' ? (data[k] as string).slice(0, 2000) : undefined);
    await saveAlert({ alertType: s('alert_type'), name: s('name') ?? s('alert_name'), text: s('text'), accountId: s('account_id'), data });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[hooks/cloudflare]', err);
    return NextResponse.json({ ok: false }, { status, headers: err instanceof HttpError ? err.headers : undefined });
  }
}
