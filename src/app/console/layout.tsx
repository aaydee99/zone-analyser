import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';
import { preview } from '@/lib/preview';

// Everything under /console is private: never in search results.
export const metadata: Metadata = {
  title: { default: `${BRAND.name} console`, template: `%s · ${BRAND.name}` },
  robots: { index: false, follow: false },
  // A console link pasted in chat previews as the product, never as the page's data.
  description: `Sign in to your ${BRAND.name} console.`,
  ...preview({ title: `${BRAND.name} console`, description: `Sign in to your ${BRAND.name} console.` }),
};

export default function ConsoleRoot({ children }: { children: React.ReactNode }) {
  return children;
}
