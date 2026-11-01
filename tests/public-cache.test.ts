import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import nextConfig from '../next.config';

// Next.js applies every matching headers() rule in order, and a later rule's value for the same
// key wins: this mirrors that for plain sources (exact paths and a trailing ":name*").
async function cacheControl(path: string, rsc = false) {
  let value: string | undefined;
  for (const rule of await nextConfig.headers!()) {
    const src = rule.source;
    const hit = src.endsWith('*') ? path.startsWith(src.replace(/:\w+\*$/, '')) || path === src.replace(/\/:\w+\*$/, '') : path === src;
    if (!hit || (rsc && rule.missing?.some((m) => m.type === 'header' && m.key === 'rsc'))) continue;
    value = rule.headers.find((h) => h.key === 'Cache-Control')?.value ?? value;
  }
  return value;
}

test('only the public landing, legal and brand files may be cached', async () => {
  for (const p of ['/', '/privacy', '/terms', '/licenses', '/opengraph-image', '/robots.txt', '/sitemap.xml']) assert.match((await cacheControl(p))!, /^public, max-age=0, s-maxage=300/, p);
  for (const p of ['/brand/castellan-logo.svg', '/icon.svg']) assert.equal(await cacheControl(p), 'public, max-age=86400', p);
  for (const p of ['/console', '/console/login', '/console/runs/1', '/api/auth/me', '/privacy/x', '/login']) assert.equal(await cacheControl(p), 'no-store', p);
  assert.equal(await cacheControl('/', true), 'no-store', 'RSC payload of /');
});

test('the proxy runs on pages and API routes, not on static assets', () => {
  // proxy.ts imports next/server, which this runner cannot load: read the matcher from the source.
  const src = readFileSync(new URL('../src/proxy.ts', import.meta.url), 'utf8');
  const m = /matcher: \['([^']+)'\]/.exec(src)![1].replace(/\\\\/g, '\\');
  const re = new RegExp(`^${m}$`);
  for (const p of ['/', '/console', '/console/login', '/api/auth/me', '/opengraph-image', '/robots.txt', '/privacy']) assert.ok(re.test(p), p);
  for (const p of ['/_next/static/chunks/a.js', '/_next/image', '/brand/castellan-logo.svg', '/icon.svg', '/favicon.ico']) assert.ok(!re.test(p), p);
});
