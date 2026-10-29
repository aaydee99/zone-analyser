import type { NextConfig } from 'next';

// The Content-Security-Policy is set per request in src/proxy.ts (it depends on runtime settings).

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The backup script is spawned by path at runtime, never bundled.
  outputFileTracingExcludes: { '*': ['./runner/**', './data/**'] },
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
    }];
  },
};

export default nextConfig;
