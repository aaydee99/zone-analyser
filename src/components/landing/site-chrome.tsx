import Link from 'next/link';
import { Archivo } from 'next/font/google';
import { ArrowLeft } from 'lucide-react';
import { BRAND, salesHref } from '@/lib/brand';
import { LEGAL, LEGAL_NOTICE, isTodo } from '@/lib/legal';
import { BrandMark } from '@/components/brand-mark';

// What the public pages share: the display face, the wordmark, the footer and the frame of the
// example legal pages (/privacy, /terms, /licenses). Server components only.

// One display face for the public pages only (self-hosted by next/font at build, so the CSP holds).
export const display = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-archivo', display: 'swap' });

export const LEGAL_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/licenses', label: 'Open-source notices' },
];

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2">
      <BrandMark className="h-6" intro />
      <span className="lp-h3 text-[1.15rem] text-ink">{BRAND.name}</span>
    </span>
  );
}

/** A company fact from LEGAL: marked up so an unfilled "[TODO: …]" stands out on the page. */
export function Fill({ v }: { v: string }) {
  return isTodo(v) ? <mark className="rounded bg-warn/15 px-1 font-mono text-[0.92em] text-warn">{v}</mark> : <>{v}</>;
}

export function SiteFooter({ home = true }: { home?: boolean }) {
  const a ='text-ink-2 hover:text-ink';
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[minmax(0,1fr)_auto] lg:px-8">
        <div>
          <Wordmark />
          <p className="mt-3 max-w-md text-[14px] text-muted">{BRAND.tagline}.</p>
        </div>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-6 gap-y-3 text-[14px]">
            <li><Link href="/console/login" className={a}>Sign in</Link></li>
            <li><a href={salesHref()} className={a}>Contact sales</a></li>
            <li><Link href={home ? '#faq' : '/#faq'} className={a}>FAQ</Link></li>
          </ul>
        </nav>
        <div className="space-y-2 text-[12.5px] leading-relaxed text-faint md:col-span-2">
          <p>
            © <Fill v={LEGAL.entityName} /> · <Fill v={LEGAL.registeredAddress} /> · Company no. <Fill v={LEGAL.companyNumber} />
          </p>
          <nav aria-label="Legal">
            <ul className="flex flex-wrap gap-x-1.5">
              {LEGAL_LINKS.map((l, i) => (
                <li key={l.href}>{i > 0 && <span aria-hidden="true">· </span>}<Link href={l.href} className="lp-link text-muted hover:text-ink">{l.label}</Link></li>
              ))}
            </ul>
          </nav>
          {home && <p>Zones, numbers and notifications in the demos on this page are sample data on example.com and example.net.</p>}
          <p>Cloudflare is a trademark of Cloudflare, Inc.</p>
        </div>
      </div>
    </footer>
  );
}

/** The frame of a legal page: a slim header, the draft notice, the text and the footer. */
export function LegalPage({ title, lede, children }: { title: string; lede: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`${display.variable} overflow-x-clip`}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-lg focus:bg-signal focus:px-4 focus:py-2 focus:font-semibold focus:text-signal-ink">
        Skip to content
      </a>
      <header className="lp-header sticky top-0 z-50">
        <div className="relative mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <Link href="/" aria-label={`${BRAND.name} home`} className="rounded-md"><Wordmark /></Link>
          <Link href="/" className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[14px] text-ink-2 hover:bg-raised hover:text-ink"><ArrowLeft aria-hidden="true" className="size-4" />Home</Link>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
        <p role="note" className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-[15px] font-semibold text-warn">{LEGAL_NOTICE}</p>
        <h1 className="lp-h2 mt-10 text-ink">{title}</h1>
        <p className="mt-3 font-mono text-[12.5px] text-faint">Version <Fill v={LEGAL.version} /> · Effective <Fill v={LEGAL.effectiveDate} /></p>
        <div className="lp-copy mt-6">{lede}</div>
        <div className="mt-10 space-y-10">{children}</div>
      </main>
      <SiteFooter home={false} />
    </div>
  );
}

/** One numbered section of a legal page. */
export function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3 text-[15.5px] leading-relaxed text-muted [&_a]:text-ink-2 [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-ink [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-ink-2 [&_ul]:space-y-1.5">
      <h2 id={id} className="lp-h3 text-[1.3rem] text-ink">{title}</h2>
      {children}
    </section>
  );
}
