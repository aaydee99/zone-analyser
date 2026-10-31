import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';

// Everything under /console is private: never in search results.
export const metadata: Metadata = {
  title: { default: `${BRAND.name} console`, template: `%s · ${BRAND.name}` },
  robots: { index: false, follow: false },
};

export default function ConsoleRoot({ children }: { children: React.ReactNode }) {
  return children;
}
