import type { NextConfig } from 'next';

// The Content-Security-Policy is set per request in src/proxy.ts (it depends on runtime settings).

const SHORT = 'public, max-age=0, s-maxage=300, stale-while-revalidate=60';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // forbidden(): a page a role may not open answers 403, not 404.
  experimental: { authInterrupts: true },
  // The backup script is spawned by path at runtime, never bundled.
  outputFileTracingExcludes: { '*': ['./runner/**', './data/**'] },
  // The console moved under /console (the landing page is at /): old links and bookmarks still work.
  async redirects() {
    const moved = ['login', 'setup', 'unlock', 'account', 'approvals', 'audit', 'backup', 'changes', 'cloudflare-activity', 'restore', 'runs', 'settings', 'traffic', 'users', 'vault', 'zone-explorer'];
    return moved.map((p) => ({ source: `/${p}/:path*`, destination: `/console/${p}/:path*`, permanent: true }));
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Cache-Control', value: 'no-store' },
        // Other sites can neither open this app in a shared browsing context nor embed its resources.
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        { key: 'X-DNS-Prefetch-Control', value: 'off' },
        { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
      ],
    },
    // Public, identical for every visitor: the landing and legal pages (HTML only, not their RSC
    // payloads) and the generated metadata files get a short CDN cache, the brand files a day.
    // Listed after the rule above, so their Cache-Control replaces no-store; everything else
    // (/console/*, /api/*, RSC) stays no-store.
    ...['/', '/privacy', '/terms', '/licenses'].map((source) => ({ source, missing: [{ type: 'header' as const, key: 'rsc' }], headers: [{ key: 'Cache-Control', value: SHORT }] })),
    ...['/opengraph-image', '/robots.txt', '/sitemap.xml'].map((source) => ({ source, headers: [{ key: 'Cache-Control', value: SHORT }] })),
    ...['/brand/:file*', '/icon.svg'].map((source) => ({ source, headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }] })),
    ];
  },
};

export default nextConfig;
