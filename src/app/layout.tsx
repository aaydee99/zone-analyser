import type { Metadata, Viewport } from 'next';
import { Fira_Code, Fira_Sans } from 'next/font/google';
import { ToastProvider } from '@/components/toast';
import { BRAND } from '@/lib/brand';
import { preview } from '@/lib/preview';
import { LEGAL } from '@/lib/legal';
import './globals.css';

// Only the weights in use: Sans 400/500/600 (font-medium, font-semibold) and 700 (<b> and <th>
// default to bold); Code 400/500/600 (h1-h3 and font-mono). Code stays preloaded: it is every
// console page's heading font.
const sans = Fira_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-fira-sans' });
const mono = Fira_Code({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-fira-code' });

/** The public address (CONSOLE_PUBLIC_URL, else the website), so link previews get absolute URLs. */
const publicUrl = (() => { try { return new URL(process.env.CONSOLE_PUBLIC_URL || BRAND.site); } catch { return new URL(BRAND.site); } })();
const title = `${BRAND.name} — ${BRAND.tagline}`;

// Link previews (Open Graph, X/Twitter) for every page; pages set their own title, description and
// URL. The image is opengraph-image.tsx / twitter-image.tsx (1200×630, built once).
export const metadata: Metadata = {
  metadataBase: publicUrl,
  title,
  description: BRAND.description,
  applicationName: BRAND.name,
  creator: LEGAL.entityName,
  publisher: LEGAL.entityName,
  formatDetection: { email: false, address: false, telephone: false },
  ...preview({ title, description: BRAND.description }),
};

export const viewport: Viewport = { themeColor: '#0b0b0e', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
