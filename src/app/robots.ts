import type { MetadataRoute } from 'next';
import { siteOrigin } from './site-url';

// Only the landing page is public. The console and its API are private: never crawled (each
// console page also says noindex, see src/app/console/layout.tsx).
export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await siteOrigin();
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/console', '/console/', '/api/'] },
    sitemap: `${origin}/sitemap.xml`,
  };
}
