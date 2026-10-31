import type { MetadataRoute } from 'next';
import { siteOrigin } from './site-url';

// The public pages: only the landing page. Console pages are private and left out on purpose.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteOrigin();
  return [{ url: `${origin}/`, changeFrequency: 'monthly', priority: 1 }];
}
