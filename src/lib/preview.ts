import type { Metadata } from 'next';
import { BRAND } from './brand';

// Link-preview tags (Open Graph, X/Twitter) for one page. A page's own openGraph replaces the
// layout's whole, image included, so every page names the image (src/app/opengraph-image.tsx and
// twitter-image.tsx, 1200×630) here.

const IMAGE = { width: 1200, height: 630, alt: `${BRAND.name}: ${BRAND.tagline}` };

export function preview({ title, description, url }: { title: string; description: string; url?: string }): Pick<Metadata, 'openGraph' | 'twitter'> {
  return {
    openGraph: { type: 'website', siteName: BRAND.name, locale: 'en_US', title, description, ...(url ? { url } : {}), images: [{ url: '/opengraph-image', ...IMAGE }] },
    twitter: { card: 'summary_large_image', title, description, images: [{ url: '/twitter-image', ...IMAGE }] },
  };
}
