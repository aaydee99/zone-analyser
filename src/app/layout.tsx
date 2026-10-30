import type { Metadata } from 'next';
import { Fira_Code, Fira_Sans } from 'next/font/google';
import { SpeedInsights } from '@vercel/speed-insights/next';
import { ToastProvider } from '@/components/toast';
import './globals.css';

const sans = Fira_Sans({ subsets: ['latin'], weight: ['300', '400', '500', '600', '700'], variable: '--font-fira-sans' });
const mono = Fira_Code({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-fira-code' });

export const metadata: Metadata = {
  title: 'Backup Console',
  description: 'Back up Cloudflare zones and account configuration to Terraform and JSON',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen">
        <ToastProvider>{children}</ToastProvider>
        <SpeedInsights />
      </body>
    </html>
  );
}
