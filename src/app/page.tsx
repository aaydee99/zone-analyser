import type { Metadata } from 'next';
import Link from 'next/link';
import { Archivo } from 'next/font/google';
import { ArrowRight, Check, FileCode2, FileJson, Folder, Mail, Minus, Plus, Undo2 } from 'lucide-react';
import { BRAND } from '@/lib/brand';
import { RULE_PHASES, SETTING_IDS, ZONE_ENDPOINTS, ZONE_GROUPS } from '@/lib/zone-catalog';
import { CATEGORIES } from '@/lib/cf-classify';
import { ROLES, ROLE_META } from '@/lib/rbac';
import { BackupButton } from '@/components/landing/backup-button';
import { ConsoleTour } from '@/components/landing/console-tour';
import { CountUp } from '@/components/landing/count-up';
import { DiffSlider } from '@/components/landing/diff-slider';
import { HeroHeadline } from '@/components/landing/hero-headline';
import { MobileNav } from '@/components/landing/mobile-nav';
import { Reveal } from '@/components/landing/reveal';
import { BrandMark } from '@/components/brand-mark';
import { HeroField } from '@/components/landing/hero-field';
import { Spotlight } from '@/components/landing/spotlight';

// The public landing page. A Server Component, rendered statically at build time: no cookies, no
// request-time data. Interactive pieces are small client components in src/components/landing/.

// One display face for the landing page only (self-hosted by next/font at build, so the CSP holds).
const display = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-archivo', display: 'swap' });

export const metadata: Metadata = {
  title: `${BRAND.name} — ${BRAND.tagline}`,
  description: BRAND.description,
  robots: { index: true, follow: true },
  openGraph: { type: 'website', siteName: BRAND.name, title: `${BRAND.name} — ${BRAND.tagline}`, description: BRAND.description },
  twitter: { card: 'summary', title: `${BRAND.name} — ${BRAND.tagline}`, description: BRAND.description },
};

// ── Product facts shown as numbers. Each one comes from the code, nothing is estimated. ──────────
/** What the Zone explorer reads for one zone: its API endpoints, each zone setting (read one by one)
 *  and each rule page (one ruleset phase entrypoint). src/lib/zone-catalog.ts: ZONE_ENDPOINTS,
 *  SETTING_IDS and RULE_PHASES. */
const ZONE_READS = ZONE_ENDPOINTS.length + SETTING_IDS.length + RULE_PHASES.length;
/** Terraform resource types a backup exports with cf-terraforming. Counted by hand in
 *  runner/backup.js (a CommonJS script, not importable here): ZONE_RESOURCES has 57 entries and
 *  ACCOUNT_RESOURCES has 77. Recount if either list changes. */
const TF_ZONE_TYPES = 57;
const TF_ACCOUNT_TYPES = 77;
/** Change categories Cloudflare activity sorts the audit log into: src/lib/cf-classify.ts CATEGORIES. */
const CHANGE_CATEGORIES = CATEGORIES.length;
/** Traffic drill-down levels: month → day → hour → minute (src/lib/traffic-security.ts TIME_DIM:
 *  daily / hourly / minutes windows under the month). */
const DRILL_LEVELS = 4;
/** Roles: src/lib/rbac.ts ROLES. */
const ROLE_COUNT = ROLES.length;

const NAV = [
  { href: '#product', label: 'Product' },
  { href: '#how', label: 'How it works' },
  { href: '#security', label: 'Security' },
  { href: '#plans', label: 'Plans' },
  { href: '#faq', label: 'FAQ' },
];

const SALES_HREF = `mailto:${BRAND.salesEmail}?subject=${encodeURIComponent(`${BRAND.name}: plans and pricing`)}`;

export default function Landing() {
  return (
    <div className={`${display.variable} overflow-x-clip`}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-lg focus:bg-signal focus:px-4 focus:py-2 focus:font-semibold focus:text-signal-ink">
        Skip to content
      </a>
      <Spotlight />
      <Header />
      <main id="main">
        <Hero />
        <Facts />
        <Product />
        <Process />
        <BeforeAfter />
        <Compare />
        <Security />
        <Plans />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

// ── Header ──────────────────────────────────────────────────────────────────
function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2">
      <BrandMark className="h-6" intro />
      <span className="lp-h3 text-[1.15rem] text-ink">{BRAND.name}</span>
    </span>
  );
}

function Header() {
  return (
    <header className="lp-header sticky top-0 z-50">
      <div aria-hidden="true" className="lp-progress" />
      <div className="relative mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" aria-label={`${BRAND.name} home`} className="rounded-md"><Wordmark /></Link>
        <nav aria-label="Sections" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {NAV.map((l) => (
              <li key={l.href}><a href={l.href} className="rounded-lg px-3 py-2 text-[14px] text-ink-2 transition-colors hover:bg-raised hover:text-ink">{l.label}</a></li>
            ))}
          </ul>
        </nav>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <Link href="/console/login" className="hidden min-h-11 items-center rounded-[10px] px-3 text-[14px] text-ink-2 transition-colors hover:bg-raised hover:text-ink sm:inline-flex">Sign in</Link>
          <Link href="/console" className="lp-btn lp-btn-primary min-h-10 px-4 text-[14px]">Open console</Link>
          <MobileNav links={NAV} />
        </div>
      </div>
    </header>
  );
}

// ── Hero ────────────────────────────────────────────────────────────────────
function Hero() {
  return (
    <section aria-labelledby="hero-title" className="lp-hero pt-14 pb-16 sm:pt-20 lg:pt-24">
      <HeroField />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-5xl">
          <HeroHeadline />
        </div>
        <div className="mt-8 grid gap-8 lg:mt-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <p className="lp-lede lp-enter" style={{ '--lp-d': '220ms' } as React.CSSProperties}>{BRAND.description}</p>
          <div className="lp-enter flex flex-wrap gap-3" style={{ '--lp-d': '360ms' } as React.CSSProperties}>
            <Link href="/console" className="lp-btn lp-btn-primary">Open console <ArrowRight aria-hidden="true" className="size-4" /></Link>
            <a href={SALES_HREF} className="lp-btn lp-btn-ghost">Talk to sales</a>
          </div>
        </div>
        <p className="lp-enter mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[13.5px] text-muted" style={{ '--lp-d': '440ms' } as React.CSSProperties}>
          <span className="inline-flex items-center gap-1.5"><Check aria-hidden="true" className="size-4 text-signal" />Terraform and JSON, in your own R2 or S3 bucket</span>
          <span className="inline-flex items-center gap-1.5"><Check aria-hidden="true" className="size-4 text-signal" />Compare and plan never write to Cloudflare</span>
          <span className="inline-flex items-center gap-1.5"><Check aria-hidden="true" className="size-4 text-signal" />Every action in an audit log</span>
        </p>
        <div className="lp-enter-mock mt-12 sm:mt-14" style={{ '--lp-d': '520ms' } as React.CSSProperties}>
          <ConsoleTour />
        </div>
      </div>
    </section>
  );
}

// ── Facts (count-up) ────────────────────────────────────────────────────────
function Facts() {
  const facts: { value: number; title: string; body: string }[] = [
    { value: ZONE_READS, title: 'reads behind every zone', body: `The Zone explorer reads ${ZONE_ENDPOINTS.length} Cloudflare API endpoints, ${SETTING_IDS.length} zone settings one by one, and ${RULE_PHASES.length} rule pages for any zone the token can see.` },
    { value: TF_ZONE_TYPES + TF_ACCOUNT_TYPES, title: 'Terraform resource types per backup', body: `${TF_ZONE_TYPES} for each zone and ${TF_ACCOUNT_TYPES} for the account, exported with cf-terraforming. What Terraform can't hold is saved as JSON from the API.` },
    { value: CHANGE_CATEGORIES, title: 'categories of Cloudflare changes', body: 'The audit log, sorted into DNS, security rules, cache, SSL/TLS, Zero Trust, API tokens and more, each with the old and new value.' },
    { value: DRILL_LEVELS, title: 'levels of traffic drill-down', body: 'Month, then day, then hour, then minute, each narrowed to its rule hits, top IPs and top paths.' },
    { value: ROLE_COUNT, title: 'roles, enforced on the server', body: ROLES.slice().reverse().map((r) => ROLE_META[r].label).join(', ') + '. Operators ask, admins approve; restores wait for a super admin.' },
  ];
  return (
    <section aria-labelledby="facts-title" className="border-y border-line bg-sunken/50">
      <Reveal className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div className="lp-rv grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
          <h2 id="facts-title" className="lp-h2 text-ink">What it covers, in numbers.</h2>
          <p className="lp-copy self-end">What {BRAND.name} reads, keeps and shows for every account and zone your tokens can see.</p>
        </div>
        <ul className="mt-12 grid gap-x-8 sm:grid-cols-2 xl:grid-cols-5">
          {facts.map((f, i) => (
            <li key={f.title} className="lp-rv border-t border-line pt-6 pb-8" style={{ '--i': i } as React.CSSProperties}>
              <p className="m-0">
                <span className="lp-num lp-gold block text-[clamp(3rem,2rem+3vw,4.25rem)]"><CountUp value={f.value} /></span>
                <span className="mt-3 block font-semibold text-ink">{f.title}</span>
              </p>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">{f.body}</p>
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}

// ── Product (bento) ─────────────────────────────────────────────────────────
function Product() {
  const groups = ZONE_GROUPS.slice(0, 11).map((g) => g.label);
  return (
    <section id="product" aria-labelledby="product-title" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end lg:gap-16">
          <h2 id="product-title" className="lp-rv lp-h2 text-ink">Your whole Cloudflare setup, kept, readable and reversible.</h2>
          <p className="lp-rv lp-copy" style={{ '--i': 1 } as React.CSSProperties}>Six parts of one console, sharing the same accounts, zones and roles. Each one reads Cloudflare for you, so nobody has to click through the dashboard to find out what is there.</p>
        </Reveal>

        <Reveal className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3" threshold={0.08}>
          {/* Backup */}
          <article className="lp-tile flex flex-col p-6 sm:p-8 md:col-span-2 lg:row-span-2" style={{ '--i': 0, '--tx': '-28px' } as React.CSSProperties}>
            <h3 className="lp-h3 text-[1.6rem] text-ink sm:text-[1.9rem]">Backup</h3>
            <p className="lp-copy mt-3">Every zone and account setting, exported to Terraform (.tf) and JSON and uploaded to the R2 or S3 buckets a super admin approved. Run it now, save it as a preset, or let operators request one for an admin to approve.</p>
            <div className="mt-6 flex-1 rounded-xl border border-line bg-terminal p-4 font-mono text-[12.5px] leading-[1.9] text-ink-2">
              <p className="flex items-center gap-2 text-ink"><Folder aria-hidden="true" className="size-4 text-signal" />Production_20261030_020000/</p>
              <ul className="ml-2 border-l border-line pl-4">
                <li className="flex items-center gap-2"><Folder aria-hidden="true" className="size-4 text-faint" />example.com/</li>
                <li className="ml-6 flex items-center gap-2"><FileCode2 aria-hidden="true" className="size-4 text-faint" />cloudflare_dns_record.tf</li>
                <li className="ml-6 flex items-center gap-2"><FileCode2 aria-hidden="true" className="size-4 text-faint" />cloudflare_ruleset.tf</li>
                <li className="ml-6 flex items-center gap-2"><FileCode2 aria-hidden="true" className="size-4 text-faint" />cloudflare_zone_setting.tf</li>
                <li className="flex items-center gap-2"><Folder aria-hidden="true" className="size-4 text-faint" />api_backup/</li>
                <li className="ml-6 flex items-center gap-2"><FileJson aria-hidden="true" className="size-4 text-faint" />account_details.json</li>
              </ul>
              <p className="mt-2 text-[11px] text-faint">Sample folder · names follow the backup&apos;s own layout</p>
            </div>
            <div className="mt-6"><BackupButton /></div>
          </article>

          {/* Restore */}
          <article className="lp-tile p-6 sm:p-7" style={{ '--i': 1, '--tx': '28px' } as React.CSSProperties}>
            <h3 className="lp-h3 text-ink">Restore</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted">Put one zone back the way its newest backup has it: only what changed since, or the whole zone.</p>
            <ol className="mt-5 flex flex-wrap items-center gap-1.5 text-[12.5px]">
              {['Compare', 'Plan', 'Apply', 'Verify'].map((s, i) => (
                <li key={s} className="inline-flex items-center gap-1.5">
                  <span className="rounded-md border border-line-strong bg-raised px-2 py-1 text-ink-2">{s}</span>
                  {i < 3 && <ArrowRight aria-hidden="true" className="size-3.5 text-faint" />}
                </li>
              ))}
            </ol>
            <p className="mt-4 text-[13px] text-faint">An admin&apos;s apply waits for a super admin. Every restore keeps its history.</p>
          </article>

          {/* Activity */}
          <article className="lp-tile p-6 sm:p-7" style={{ '--i': 2, '--tx': '28px' } as React.CSSProperties}>
            <h3 className="lp-h3 text-ink">Cloudflare activity</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted">The audit log as readable changes, by category, account and zone.</p>
            <div className="mt-5 rounded-xl border border-line bg-sunken/70 p-3.5">
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <span className="truncate text-ink-2">SSL/TLS · example.com</span>
                <span className="shrink-0 font-mono text-faint">09:41 UTC</span>
              </div>
              <p className="mt-2 font-mono text-[12.5px] text-ink">min_tls_version</p>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[12px]">
                <span className="lp-del rounded px-1">1.2</span><ArrowRight aria-hidden="true" className="size-3 text-faint" /><span className="lp-add rounded px-1">1.0</span>
              </p>
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="truncate text-[12px] text-muted">ops@example.com</span>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line-strong px-2 py-1 text-[12px] text-ink-2"><Undo2 aria-hidden="true" className="size-3.5" />Revert</span>
              </div>
            </div>
          </article>

          {/* Zone explorer */}
          <article className="lp-tile p-6 sm:p-7 md:col-span-2 lg:col-span-1" style={{ '--i': 3, '--tx': '-28px' } as React.CSSProperties}>
            <h3 className="lp-h3 text-ink">Zone explorer</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted">Everything the token can read about any zone, read-only, in the dashboard&apos;s own order.</p>
            <ul className="mt-5 flex flex-wrap gap-1.5" aria-label="Sections the explorer reads">
              {groups.map((g) => <li key={g} className="rounded-md border border-line bg-sunken/70 px-2 py-1 text-[12px] text-ink-2">{g}</li>)}
            </ul>
            <p className="mt-4 font-mono text-[12px] text-faint">Download: JSON · CSV · DNS as BIND</p>
          </article>

          {/* Analytics */}
          <article className="lp-tile p-6 sm:p-7 md:col-span-2" style={{ '--i': 4, '--tx': '28px' } as React.CSSProperties}>
            <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
              <div>
                <h3 className="lp-h3 text-ink">Traffic &amp; security analytics</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-muted">A month of requests for an account or a zone: cached against origin, threats, what was mitigated and what got through, hits per WAF managed, custom and rate-limiting rule, top IPs and paths.</p>
              </div>
              <figure className="m-0" aria-label="Sample month: share of requests">
                <div className="flex h-3 overflow-hidden rounded-full" aria-hidden="true">
                  <span className="bg-signal" style={{ width: '71%' }} />
                  <span className="bg-info/70" style={{ width: '27%' }} />
                  <span className="bg-bad" style={{ width: '2%' }} />
                </div>
                <figcaption className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
                  <span><span className="block font-mono text-[15px] text-ink">71%</span><span className="text-muted">cached</span></span>
                  <span><span className="block font-mono text-[15px] text-ink">27%</span><span className="text-muted">from origin</span></span>
                  <span><span className="block font-mono text-[15px] text-ink">2%</span><span className="text-muted">mitigated</span></span>
                </figcaption>
                <p className="mt-2 text-[11px] text-faint">Sample month</p>
              </figure>
            </div>
          </article>

          {/* Vault & access */}
          <article className="lp-tile p-6 sm:p-7 md:col-span-2 lg:col-span-3" style={{ '--i': 5, '--ty': '32px' } as React.CSSProperties}>
            <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center">
              <div>
                <h3 className="lp-h3 text-ink">Credential vault &amp; roles</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-muted">Cloudflare tokens and bucket keys, encrypted before they are stored, and four roles that decide who may see, run, approve and restore.</p>
              </div>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {ROLES.slice().reverse().map((r) => (
                  <li key={r} className="rounded-xl border border-line bg-sunken/70 p-3">
                    <span className="block text-[13px] font-semibold text-ink">{ROLE_META[r].label}</span>
                    <span className="mt-1 block text-[12px] leading-snug text-muted">{ROLE_BLURB[r]}</span>
                  </li>
                ))}
              </ul>
            </div>
          </article>
        </Reveal>
      </div>
    </section>
  );
}

const ROLE_BLURB: Record<(typeof ROLES)[number], string> = {
  viewer: 'Runs, logs, backup files and the Zone explorer.',
  operator: 'Requests backups and uses presets.',
  admin: 'Approves backups, plans restores, manages people.',
  super_admin: 'The vault, restore applies and reverts.',
};

// ── Process (line draw) ─────────────────────────────────────────────────────
function Process() {
  const steps = [
    { title: 'Connect a token', body: 'Add an account set to the vault: a Cloudflare API token, plus the R2 or S3 buckets its backups may go to. Leave the account ID empty to use every account the token can see.' },
    { title: 'Back up', body: 'Start a run, use a preset, or send a request for an admin to approve. Each zone and the account land in your bucket as .tf files and JSON, with a full, redacted log.' },
    { title: 'Compare', body: 'Pick a zone. The console finds the newest backup that has it, reads the audit log since then, and plans every block against the live zone, read-only.' },
    { title: 'Restore', body: 'Review each field that differs, live against backup, then apply. Afterwards the zone is checked against the backup again and the result is kept in Restore history.' },
  ];
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-20 border-t border-line py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="max-w-3xl">
          <h2 id="how-title" className="lp-rv lp-h2 text-ink">From a token to a restored zone, in four steps.</h2>
        </Reveal>
        <Reveal threshold={0.3} className="relative mt-14">
          <span aria-hidden="true" className="lp-rail-track top-5 bottom-12 left-5 w-0.5 lg:top-5 lg:right-auto lg:bottom-auto lg:h-0.5 lg:w-[calc(75%+1.5rem)]" />
          <span aria-hidden="true" className="lp-rail top-5 bottom-12 left-5 w-0.5 lg:top-5 lg:right-auto lg:bottom-auto lg:h-0.5 lg:w-[calc(75%+1.5rem)]" />
          <ol className="relative grid gap-10 lg:grid-cols-4 lg:gap-8">
            {steps.map((s, i) => (
              <li key={s.title} className="grid grid-cols-[2.5rem_1fr] gap-x-5 lg:grid-cols-1" style={{ '--i': i } as React.CSSProperties}>
                <span aria-hidden="true" className="lp-stop lp-num relative z-10 grid size-10 place-items-center rounded-full text-[15px]">{i + 1}</span>
                <div className="lp-stop-copy lg:mt-6">
                  <h3 className="lp-h3 text-ink"><span className="sr-only">Step {i + 1}: </span>{s.title}</h3>
                  <p className="mt-2 max-w-[38ch] text-[15px] leading-relaxed text-muted">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </section>
  );
}

// ── Before / after ──────────────────────────────────────────────────────────
function BeforeAfter() {
  return (
    <section aria-labelledby="ba-title" className="bg-sunken/50 py-20 sm:py-28">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:items-center lg:gap-16 lg:px-8">
        <Reveal>
          <h2 id="ba-title" className="lp-rv lp-h2 text-ink">Someone switched a WAF rule to log. Put it back.</h2>
          <p className="lp-rv lp-copy mt-5" style={{ '--i': 1 } as React.CSSProperties}>A restore reads the zone as it is now and lists every field that differs from the backup, before anything is sent to Cloudflare. Deleted since the backup? It is re-created. Added since? It is offered for deletion.</p>
          <ul className="lp-rv mt-6 space-y-2.5 text-[15px] text-ink-2" style={{ '--i': 2 } as React.CSSProperties}>
            {['Differs: shown field by field, live → backup', 'Deleted: re-created from the backup', 'Not in the backup: offered as a delete, selected'].map((t) => (
              <li key={t} className="flex gap-2.5"><Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-signal" />{t}</li>
            ))}
          </ul>
        </Reveal>
        <DiffSlider />
      </div>
    </section>
  );
}

// ── Us vs them ──────────────────────────────────────────────────────────────
function Compare() {
  const rows: { task: string; hand: string; us: string }[] = [
    { task: 'Keeping a copy', hand: 'Dashboard screenshots, or cf-terraforming run once per resource type, per zone, with the output kept wherever it ran.', us: `One run exports every zone and the account: ${TF_ZONE_TYPES + TF_ACCOUNT_TYPES} resource types to Terraform (it uses cf-terraforming), the rest as JSON, uploaded to an approved bucket.` },
    { task: 'Knowing what changed', hand: 'Reading audit-log entries one JSON object at a time.', us: `Each change with its old and new value, who made it and when, sorted into ${CHANGE_CATEGORIES} categories.` },
    { task: 'Putting it back', hand: 'Writing imports by hand and hoping the plan only touches what you meant.', us: 'Compare with the live zone, read the plan field by field, apply. Or revert one change from the activity log.' },
    { task: 'Who may do what', hand: 'Whoever has the token can do everything the token can.', us: `${ROLE_COUNT} roles enforced on the server, approvals for backups and restores, and an audit log of every action.` },
    { task: 'Traffic questions', hand: 'Opening the analytics of one zone at a time.', us: 'An account or a zone for a month, down to the minute, with rule hits, top IPs and top paths.' },
  ];
  return (
    <section aria-labelledby="vs-title" className="py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="max-w-3xl">
          <h2 id="vs-title" className="lp-rv lp-h2 text-ink">By hand, or with {BRAND.name}.</h2>
          <p className="lp-rv lp-copy mt-5" style={{ '--i': 1 } as React.CSSProperties}>Most teams keep Cloudflare safe with dashboard clicks and a script someone wrote once. Here is the same work, side by side.</p>
        </Reveal>
        <Reveal className="mt-12">
          <table className="lp-rv lp-vs">
            <caption className="sr-only">Doing the work by hand compared with {BRAND.name}</caption>
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Task</span></th>
                <th scope="col">By hand</th>
                <th scope="col" className="is-us">{BRAND.name}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.task}>
                  <th scope="row">{r.task}</th>
                  <td className="is-them" data-label="By hand">
                    <span className="flex gap-2.5"><Minus aria-hidden="true" className="mt-1 size-4 shrink-0 text-faint" />{r.hand}</span>
                  </td>
                  <td className="is-us" data-label={BRAND.name}>
                    <span className="flex gap-2.5"><Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-signal" />{r.us}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>
      </div>
    </section>
  );
}

// ── Security ────────────────────────────────────────────────────────────────
function Security() {
  const items: { title: string; body: string }[] = [
    { title: 'Encrypted vault', body: 'Credentials are sealed with AES-256-GCM under one random 256-bit key. The copy that opens the vault is wrapped with scrypt of a separate vault password. The database only ever holds ciphertext.' },
    { title: 'Secrets stay out of logs', body: 'Backups get their secrets as environment variables, and every log line shows them as ••••••••. Only a super admin with the vault unlocked can reveal one.' },
    { title: 'Reads unless you restore', body: 'Backups, the explorer, activity and analytics only read. During compare and plan, a guard stops any write from reaching Cloudflare. Only an apply or a revert writes.' },
    { title: 'Keys held in memory', body: 'The Global API Key a restore or revert needs is kept in the console’s memory only: never on disk, in the database, the audit log or the request.' },
    { title: 'Roles on every request', body: 'Permissions are checked on the server for each call; the interface only hides what a role cannot use. Role changes and password resets sign people out everywhere.' },
    { title: 'Sessions and sign-in', body: 'Idle sessions sign out (30 minutes at most), the vault locks itself, and sign-in can require a Cloudflare Turnstile CAPTCHA.' },
    { title: 'An audit log of everything', body: 'Every sign-in, vault access, credential change, run, approval and permission change is recorded.' },
    { title: 'Locked-down delivery', body: 'HTTPS with HSTS, a strict Content Security Policy, and an allow-list of host names. With a worker, it only connects out: no public URL, open port or tunnel.' },
  ];
  return (
    <section id="security" aria-labelledby="security-title" className="scroll-mt-20 border-t border-line bg-sunken/50 py-20 sm:py-28">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16 lg:px-8">
        <Reveal className="lg:sticky lg:top-28 lg:self-start">
          <h2 id="security-title" className="lp-rv lp-h2 text-ink">It holds the keys to your edge, so it is built that way.</h2>
          <p className="lp-rv lp-copy mt-5" style={{ '--i': 1 } as React.CSSProperties}>The console keeps Cloudflare tokens and bucket keys. Everything below is how this release handles them.</p>
        </Reveal>
        <Reveal threshold={0.1}>
          <dl className="grid gap-x-10 sm:grid-cols-2">
            {items.map((it, i) => (
              <div key={it.title} className="lp-rv border-t border-line py-6" style={{ '--i': i % 2 } as React.CSSProperties}>
                <dt className="font-semibold text-ink">{it.title}</dt>
                <dd className="mt-2 text-[15px] leading-relaxed text-muted">{it.body}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>
    </section>
  );
}

// ── Plans / contact sales ───────────────────────────────────────────────────
function Plans() {
  const ways = [
    { title: 'Vercel + a worker', body: 'The web side on Vercel; backups, restores and every Cloudflare call on a worker that starts on GitHub Actions when needed.' },
    { title: 'Your own server', body: 'One Node.js process, or Docker, on a machine you control, so tokens can be limited to its fixed IP.' },
  ];
  return (
    <section id="plans" aria-labelledby="plans-title" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="grid gap-12 lg:grid-cols-[minmax(0,6fr)_minmax(0,6fr)] lg:gap-16">
          <div>
            <h2 id="plans-title" className="lp-rv lp-h2 text-ink">Plans fitted to how you run Cloudflare.</h2>
            <p className="lp-rv lp-copy mt-5" style={{ '--i': 1 } as React.CSSProperties}>A plan depends on how many accounts and zones you keep, how often you back up, and where the console should run. Tell us about your setup and we will put one together with you.</p>
            <div className="lp-rv mt-8 flex flex-wrap items-center gap-x-5 gap-y-3" style={{ '--i': 2 } as React.CSSProperties}>
              <a href={SALES_HREF} className="lp-btn lp-btn-primary"><Mail aria-hidden="true" className="size-4" />Talk to us</a>
              <a href={SALES_HREF} className="lp-link font-mono text-[14px] text-ink-2 hover:text-ink">{BRAND.salesEmail}</a>
            </div>
          </div>
          <ul className="grid content-start gap-4">
            {ways.map((w, i) => (
              <li key={w.title} className="lp-rv rounded-2xl border border-line p-6" style={{ '--i': i + 1 } as React.CSSProperties}>
                <p className="lp-h3 text-ink">{w.title}</p>
                <p className="mt-2 text-[15px] leading-relaxed text-muted">{w.body}</p>
              </li>
            ))}
            <li className="lp-rv px-1 text-[13.5px] text-faint" style={{ '--i': 3 } as React.CSSProperties}>Either way, your data stays in your Supabase project and your own buckets.</li>
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

// ── FAQ ─────────────────────────────────────────────────────────────────────
function Faq() {
  const qa: { q: string; a: string }[] = [
    { q: 'Does it need write access to Cloudflare?', a: 'Not for its everyday work. Backups, the Zone explorer, Cloudflare activity and analytics only read. Applying a restore or reverting a change are the only writes, and both ask for a Global API Key at that moment, which is held in memory only.' },
    { q: 'What exactly is in a backup?', a: `Terraform files for each zone and the account, generated with cf-terraforming across ${TF_ZONE_TYPES + TF_ACCOUNT_TYPES} resource types, plus JSON from Cloudflare’s API for what Terraform cannot express. It is uploaded to your R2 or S3 bucket, and you can download any run as a .zip.` },
    { q: 'Can I restore one zone, or only part of it?', a: 'Restores work one zone at a time. By default only what the audit log says changed since the backup is compared; Compare everything checks the whole zone. You review the plan before anything is applied.' },
    { q: 'Who is allowed to restore?', a: 'Admins and super admins can compare and plan. An admin’s apply waits for a super admin to approve it; super admins apply directly. Reverting a single change from Cloudflare activity is for super admins.' },
    { q: 'We have several Cloudflare accounts. Does that work?', a: 'Yes. Leave the account ID empty and the console uses every account the token can access: zone pickers list them all, a backup runs once per account, and Cloudflare activity reads every account’s audit log.' },
    { q: 'Where does it run, and where is our data?', a: 'On Vercel with a worker (started on GitHub Actions, or on your own machine), or entirely on your own server or Docker. Accounts, the vault ciphertext and history live in your Supabase project; backups live in your buckets.' },
    { q: 'How far back do traffic analytics go?', a: 'As far as Cloudflare keeps analytics for your plan. When part of a month is past that, the page says exactly which days were read.' },
  ];
  return (
    <section id="faq" aria-labelledby="faq-title" className="scroll-mt-20 border-t border-line py-20 sm:py-28">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16 lg:px-8">
        <h2 id="faq-title" className="lp-h2 text-ink">Questions teams ask first.</h2>
        <div className="border-b border-line">
          {qa.map((x) => (
            <details key={x.q} className="lp-faq group border-t border-line">
              <summary className="flex min-h-14 items-center justify-between gap-6 py-5 text-left text-[16.5px] font-semibold text-ink transition-colors hover:text-signal-soft">
                <h3 className="m-0 font-sans text-[inherit] font-semibold tracking-normal">{x.q}</h3>
                <Plus aria-hidden="true" className="lp-faq-icon size-5 shrink-0 text-signal" />
              </summary>
              <p className="lp-faq-body pb-6 pr-10 text-[15.5px] leading-relaxed text-muted">{x.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Final CTA ───────────────────────────────────────────────────────────────
function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="lp-band">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <Reveal>
          <h2 id="cta-title" className="lp-rv lp-display max-w-5xl text-[clamp(2.3rem,1.3rem+4.4vw,5rem)]">Keep a copy of your edge before you need one.</h2>
          <div className="lp-rv mt-10 flex flex-wrap items-center gap-3" style={{ '--i': 1 } as React.CSSProperties}>
            <Link href="/console" className="lp-btn lp-btn-ink">Open console <ArrowRight aria-hidden="true" className="size-4" /></Link>
            <a href={SALES_HREF} className="lp-btn lp-btn-outline-ink">Contact sales</a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ── Footer ──────────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[minmax(0,1fr)_auto] lg:px-8">
        <div>
          <Wordmark />
          <p className="mt-3 max-w-md text-[14px] text-muted">{BRAND.tagline}.</p>
        </div>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-6 gap-y-3 text-[14px]">
            <li><Link href="/console" className="text-ink-2 hover:text-ink">Open console</Link></li>
            <li><Link href="/console/login" className="text-ink-2 hover:text-ink">Sign in</Link></li>
            <li><a href={SALES_HREF} className="text-ink-2 hover:text-ink">Contact sales</a></li>
            <li><a href="#faq" className="text-ink-2 hover:text-ink">FAQ</a></li>
          </ul>
        </nav>
        <p className="text-[12.5px] leading-relaxed text-faint md:col-span-2">
          Zones, numbers and notifications in the demos on this page are sample data on example.com and example.net.
          Cloudflare is a trademark of Cloudflare, Inc.
        </p>
      </div>
    </footer>
  );
}
