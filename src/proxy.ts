import { NextResponse, type NextRequest } from 'next/server';
import { cameThroughCdn, isAllowedHost, isHttpsRequest, isLoopbackHost } from '@/lib/hosts';

// Runs before every page, asset and API route.
//  - Unknown Host → 403 (DNS rebinding; also keeps the redirect below on our own hosts).
//  - With CONSOLE_ORIGIN_SECRET set, a request without the CDN's secret header → 403.
//  - Plain HTTP is accepted only on loopback, where traffic never leaves the machine.
//    Anything else is redirected to HTTPS (GET/HEAD) or refused, before any cookie or
//    request body is processed.
//  - Every HTTPS response carries HSTS so browsers never try HTTP again.
const HSTS = 'max-age=63072000; includeSubDomains';

// Everything the UI needs is served by the console itself (fonts are self-hosted by next/font).
// Next.js inlines its bootstrap scripts, hence 'unsafe-inline' for scripts; dev mode also needs
// 'unsafe-eval' for fast refresh. With CAPTCHA on (TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY),
// Cloudflare Turnstile's script and challenge frame are allowed — only its own origin. Built per
// request, so turning CAPTCHA on needs no rebuild.
function csp() {
  const turnstile = process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY ? ' https://challenges.cloudflare.com' : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}${turnstile}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${turnstile}`,
    `frame-src ${turnstile ? turnstile.trim() : "'none'"}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const withCsp = (res: NextResponse) => { res.headers.set('Content-Security-Policy', csp()); return res; };

export function proxy(req: NextRequest) {
  const host = req.headers.get('host');
  if (!isAllowedHost(host)) return NextResponse.json({ error: 'Host not allowed' }, { status: 403 });
  if (!cameThroughCdn(host, req.headers)) return NextResponse.json({ error: 'Direct access is not allowed' }, { status: 403 });
  // No CORS: the API is same-origin only, so a cross-origin preflight is refused (and never
  // answered with Access-Control-Allow-* headers).
  if (req.method === 'OPTIONS' && req.nextUrl.pathname.startsWith('/api/')) return NextResponse.json({ error: 'Cross-origin requests are not allowed' }, { status: 403 });

  if (!isHttpsRequest(req.url, req.headers)) {
    if (isLoopbackHost(host)) return withCsp(NextResponse.next());
    if (req.method === 'GET' || req.method === 'HEAD') {
      const to = new URL(req.nextUrl.pathname + req.nextUrl.search, `https://${host}`);
      return NextResponse.redirect(to, 308);
    }
    return NextResponse.json({ error: 'HTTPS is required' }, { status: 403 });
  }

  const res = withCsp(NextResponse.next());
  res.headers.set('Strict-Transport-Security', HSTS);
  return res;
}
