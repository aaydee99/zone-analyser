import type { MetadataRoute } from 'next';
import { siteOrigin } from './site-url';

// The public pages: the landing page and the legal pages. Console pages are private and left out on purpose.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteOrigin();
  return [
    { url: `${origin}/`, changeFrequency: 'monthly', priority: 1 },
    ...['/privacy', '/terms', '/licenses'].map((p) => ({ url: `${origin}${p}`, changeFrequency: 'yearly' as const, priority: 0.3 })),
  ];
}
