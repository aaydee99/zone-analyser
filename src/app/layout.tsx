import type { Metadata } from 'next';
import { Fira_Code, Fira_Sans } from 'next/font/google';
import { ToastProvider } from '@/components/toast';
import { BRAND } from '@/lib/brand';
import './globals.css';

const sans = Fira_Sans({ subsets: ['latin'], weight: ['300', '400', '500', '600', '700'], variable: '--font-fira-sans' });
const mono = Fira_Code({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-fira-code' });

/** The public address (CONSOLE_PUBLIC_URL), so link previews get absolute image URLs. */
const publicUrl = (() => { try { return process.env.CONSOLE_PUBLIC_URL ? new URL(process.env.CONSOLE_PUBLIC_URL) : undefined; } catch { return undefined; } })();

export const metadata: Metadata = {
  ...(publicUrl ? { metadataBase: publicUrl } : {}),
  title: `${BRAND.name} — ${BRAND.tagline}`,
  description: BRAND.description,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
