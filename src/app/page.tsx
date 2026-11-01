import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Activity, ArrowRight, BarChart3, Building2, Check, ClipboardCheck, Cloud, Database, Eraser, FileCode2, FileJson, FileOutput, FileText, Fingerprint, Folder, Gauge, GitCompare, Globe,
  HardDrive, History, KeyRound, ListFilter, Mail, MessageSquare, Minus, Plus, ScrollText, Search, Server, ShieldAlert, ShieldCheck, Star, Tags, Terminal, Undo2, Users, Webhook, Workflow,
} from 'lucide-react';
import { BRAND, salesHref } from '@/lib/brand';
import { TF_ACCOUNT_TYPES, TF_ZONE_TYPES } from '@/lib/landing-numbers';
import { CHECKS } from '@/lib/monitor-types';
import { RULE_PHASES, SETTING_IDS, ZONE_ENDPOINTS, ZONE_GROUPS } from '@/lib/zone-catalog';
import { CATEGORIES } from '@/lib/cf-classify';
import { ROLES, ROLE_META } from '@/lib/rbac';
import { ALL_RULES } from '@/lib/zone-audit/report';
import { BackupButton } from '@/components/landing/backup-button';
import { ConsoleTour } from '@/components/landing/console-tour';
import { CountUp } from '@/components/landing/count-up';
import { DiffSlider } from '@/components/landing/diff-slider';
import { HeroHeadline } from '@/components/landing/hero-headline';
import { MobileNav } from '@/components/landing/mobile-nav';
import { Reveal } from '@/components/landing/reveal';
import { HeroField } from '@/components/landing/hero-field';
import { Spotlight } from '@/components/landing/spotlight';
import { SiteFooter, Wordmark, display } from '@/components/landing/site-chrome';

// The public landing page. A Server Component, rendered statically at build time: no cookies, no
// request-time data. Interactive pieces are small client components in src/components/landing/.

export const metadata: Metadata = {
  title: `${BRAND.name} — ${BRAND.tagline}`,
  description: BRAND.description,
  robots: { index: true, follow: true },
  openGraph: { type: 'website', siteName: BRAND.name, title: `${BRAND.name} — ${BRAND.tagline}`, description: BRAND.description },
  twitter: { card: 'summary_large_image', title: `${BRAND.name} — ${BRAND.tagline}`, description: BRAND.description },
};

// ── Product facts shown as numbers. Each one comes from the code, nothing is estimated. ──────────
/** Security-audit checks: every rule the audit runs on one zone (src/lib/zone-audit/report.ts ALL_RULES). */
const AUDIT_CHECKS = ALL_RULES.length;
/** What the Zone explorer reads for one zone: its API endpoints, each zone setting (read one by one)
 *  and each rule page (one ruleset phase entrypoint). src/lib/zone-catalog.ts: ZONE_ENDPOINTS,
 *  SETTING_IDS and RULE_PHASES. */
const ZONE_READS = ZONE_ENDPOINTS.length + SETTING_IDS.length + RULE_PHASES.length;
// TF_ZONE_TYPES / TF_ACCOUNT_TYPES: src/lib/landing-numbers.ts (checked against runner/backup.js by a test).
/** Change categories Cloudflare activity sorts the audit log into: src/lib/cf-classify.ts CATEGORIES. */
const CHANGE_CATEGORIES = CATEGORIES.length;
/** Traffic drill-down levels: month → day → hour → minute (src/lib/traffic-security.ts TIME_DIM:
 *  daily / hourly / minutes windows under the month). */
const DRILL_LEVELS = 4;
/** Roles: src/lib/rbac.ts ROLES. */
const ROLE_COUNT = ROLES.length;
/** Monitoring checks the queue runs: src/lib/monitor-types.ts CHECKS. */
const CHECK_COUNT = CHECKS.length;

const NAV = [
  { href: '#audit', label: 'Security audit' },
  { href: '#monitoring', label: 'Monitoring' },
  { href: '#changes', label: 'Changes' },
  { href: '#investigate', label: 'Investigate' },
  { href: '#backup', label: 'Backup' },
  { href: '#security', label: 'Security' },
  { href: '#faq', label: 'FAQ' },
];

/** mailto: sales, or (while NEXT_PUBLIC_SALES_EMAIL is unset) the Plans section, which shows the TODO. */
const SALES_HREF = salesHref();

const d = (ms: number) => ({ '--lp-d': `${ms}ms` } as React.CSSProperties);
const i = (n: number, extra: Record<string, string> = {}) => ({ '--i': n, ...extra } as React.CSSProperties);

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
        <AuditSpotlight />
        <Facts />
        <KeepIt />
        <BackupRestore />
        <EverythingElse />
        <WhoFor />
        <Compare />
        <Integrations />
        <Security />
        <Plans />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}

// ── Header ──────────────────────────────────────────────────────────────────

function Header() {
  return (
    <header className="lp-header sticky top-0 z-50">
      <div aria-hidden="true" className="lp-progress" />
      <div className="relative mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" aria-label={`${BRAND.name} home`} className="rounded-md"><Wordmark /></Link>
        <nav aria-label="Sections" className="hidden lg:block">
          <ul className="flex items-center gap-0.5 xl:gap-1">
            {NAV.map((l) => (
              <li key={l.href}><a href={l.href} className="rounded-lg px-2.5 py-2 text-[14px] text-ink-2 transition-colors hover:bg-raised hover:text-ink xl:px-3">{l.label}</a></li>
            ))}
          </ul>
        </nav>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <Link href="/console/login" className="lp-btn lp-btn-primary min-h-10 px-4 text-[14px]">Sign in</Link>
          <MobileNav links={NAV} />
        </div>
      </div>
    </header>
  );
}

// ── 1. Hero ─────────────────────────────────────────────────────────────────
function Hero() {
  return (
    <section aria-labelledby="hero-title" className="lp-hero pt-14 pb-16 sm:pt-20 lg:pt-24">
      <HeroField />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <p className="lp-enter mb-5 text-[13.5px] font-semibold tracking-[0.02em] text-signal" style={d(0)}>Cloudflare security posture, proven on real traffic</p>
        <div className="max-w-5xl">
          <HeroHeadline />
        </div>
        <div className="mt-8 grid gap-8 lg:mt-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <p className="lp-lede lp-enter" style={d(220)}>{BRAND.description}</p>
          <div className="lp-enter flex flex-wrap gap-3" style={d(360)}>
            <Link href="/console/login" className="lp-btn lp-btn-primary">Sign in <ArrowRight aria-hidden="true" className="size-4" /></Link>
            <a href={SALES_HREF} className="lp-btn lp-btn-ghost">Talk to sales</a>
          </div>
        </div>
        <p className="lp-enter mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[13.5px] text-muted" style={d(440)}>
          <span className="inline-flex items-center gap-1.5"><Check aria-hidden="true" className="size-4 text-signal" />{AUDIT_CHECKS} checks, no AI, evidence for every finding</span>
          <span className="inline-flex items-center gap-1.5"><Check aria-hidden="true" className="size-4 text-signal" />Changes nothing in Cloudflare</span>
          <span className="inline-flex items-center gap-1.5"><Check aria-hidden="true" className="size-4 text-signal" />Every account and zone in one place</span>
        </p>
        <div className="lp-enter-mock mt-12 sm:mt-14" style={d(520)}>
          <ConsoleTour checks={AUDIT_CHECKS} />
        </div>
      </div>
    </section>
  );
}

// ── 2. Security audit (the main feature) ────────────────────────────────────
function AuditSpotlight() {
  const points: { icon: React.ReactNode; title: string; body: string }[] = [
    { icon: <ShieldAlert aria-hidden="true" className="size-4" />, title: 'Findings', body: 'Configuration, managed-rule exceptions and traffic, worst first. Each finding has a severity, a verdict, the values it was decided on and the dashboard steps that fix it.' },
    { icon: <ClipboardCheck aria-hidden="true" className="size-4" />, title: 'Recommended actions', body: 'One ranked list: critical and high first, then by the requests the change would have stopped. Skip rules come with a drafted expression that leaves out the bad slice.' },
    { icon: <Gauge aria-hidden="true" className="size-4" />, title: 'Effectiveness, rule by rule', body: 'What each custom, managed, rate-limiting, bot, DDoS and IP Access rule blocked, challenged and let through; the bots and malicious requests that passed; its top paths, countries and networks.' },
    { icon: <ShieldCheck aria-hidden="true" className="size-4" />, title: 'Managed Ruleset & OWASP', body: 'Managed rules that only log, OWASP flagging requests it never blocks, its paranoia level and score threshold, the WAF false-positive score, and what each exception lets through.' },
  ];
  const strip: { title: string; body: string }[] = [
    { title: 'Confirmed vs Needs validation', body: 'Confirmed only when the configuration or the traffic numbers prove it. Otherwise the finding names the exact check to run.' },
    { title: `Coverage of all ${AUDIT_CHECKS} checks`, body: 'Each one ends passed, finding, not applicable or not read, with the token permission that would read it.' },
    { title: 'REPORT.md, CSV and JSON', body: 'The report as Markdown, the findings as JSON, and CSV for findings, rule effectiveness, managed rulesets and coverage.' },
    { title: 'Read-only: nothing is written', body: 'The audit needs read permissions only. Fixes are written out for you and never applied.' },
  ];
  return (
    <section id="audit" aria-labelledby="audit-title" className="scroll-mt-20 border-t border-line py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="max-w-4xl">
          <p className="lp-rv text-[13.5px] font-semibold tracking-[0.02em] text-signal">Security audit</p>
          <h2 id="audit-title" className="lp-rv lp-h2 mt-3 text-ink" style={i(1)}>Does your WAF stop what it should? Measure it on your own traffic.</h2>
          <p className="lp-rv lp-copy mt-5" style={i(2)}>
            Pick a zone and a window of 24 hours, 7 days or 30 days. {AUDIT_CHECKS} fixed checks read its configuration and its security events,
            then report what each rule did to real requests and what to change. No AI: every check is plain code with a documented condition.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14">
          <Reveal as="ul" className="grid content-start gap-6">
            {points.map((p, n) => (
              <li key={p.title} className="lp-rv grid grid-cols-[2.25rem_1fr] gap-x-4" style={i(n)}>
                <span className="mt-0.5 inline-flex size-9 items-center justify-center rounded-lg border border-signal/40 bg-signal/10 text-signal">{p.icon}</span>
                <span>
                  <span className="lp-h3 block text-ink">{p.title}</span>
                  <span className="mt-1.5 block text-[15px] leading-relaxed text-muted">{p.body}</span>
                </span>
              </li>
            ))}
          </Reveal>
          <Reveal threshold={0.15}>
            <AuditMock />
          </Reveal>
        </div>

        <Reveal as="ul" className="mt-14 grid gap-x-8 border-t border-line sm:grid-cols-2 lg:grid-cols-4">
          {strip.map((s, n) => (
            <li key={s.title} className="lp-rv pt-6" style={i(n)}>
              <p className="flex items-center gap-2 font-semibold text-ink"><Check aria-hidden="true" className="size-4 shrink-0 text-signal" />{s.title}</p>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">{s.body}</p>
            </li>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

/** A still of the report: its tab labels and findings worded the way the audit writes them. Sample data. */
function AuditMock() {
  const tabs = ['Findings', 'Recommended Actions', 'Effectiveness', 'Managed Ruleset'];
  const findings: { sev: 'High' | 'Medium' | 'Low'; tone: string; verdict: string; title: string; detail: string }[] = [
    { sev: 'High', tone: 'bg-bad/12 text-bad', verdict: 'Confirmed', title: 'Custom rule “Login watch” let 18.4k automated requests through (62% of 29.7k)', detail: 'Switch “Login watch” from Log to Managed Challenge' },
    { sev: 'Medium', tone: 'bg-warn/12 text-warn', verdict: 'Confirmed', title: 'OWASP flagged 2.1k requests in the last 7 days and blocked none', detail: 'The OWASP Core Ruleset only logs' },
    { sev: 'Low', tone: 'bg-info/12 text-info', verdict: 'Confirmed', title: 'Exception “Allow uploads” skips 12 managed rules', detail: 'Effectiveness: it let 640 requests skip those rules' },
  ];
  return (
    <figure aria-label="Sample security audit report" className="lp-tile m-0 border-signal/40 p-4 sm:p-6" style={i(0, { '--tx': '28px' })}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="font-semibold text-ink">Security audit · example.com</p>
        <p className="font-mono text-[11.5px] text-faint">Sample · last 7 days · {AUDIT_CHECKS - 2} of {AUDIT_CHECKS} checks read</p>
      </div>
      <dl className="mt-4 grid grid-cols-4 gap-2">
        {[['High', '1'], ['Medium', '4'], ['Low', '3'], ['Passed', String(AUDIT_CHECKS - 2 - 8)]].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-line bg-sunken/60 px-2.5 py-2">
            <dt className="text-[11px] text-faint">{k}</dt>
            <dd className="font-mono text-[15px] text-ink tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Report tabs">
        {tabs.map((t, n) => (
          <li key={t} className={n === 0 ? 'rounded-md border border-signal/60 bg-signal/10 px-2.5 py-1 text-[12.5px] text-ink' : 'rounded-md border border-line px-2.5 py-1 text-[12.5px] text-muted'}>{t}</li>
        ))}
      </ul>
      <ul className="mt-4 space-y-2.5">
        {findings.map((f) => (
          <li key={f.title} className="rounded-xl border border-line bg-terminal px-3.5 py-3">
            <p className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className={`rounded-md px-1.5 py-0.5 font-medium ${f.tone}`}>{f.sev}</span>
              <span className={f.verdict === 'Confirmed' ? 'rounded-md bg-ok/12 px-1.5 py-0.5 font-medium text-ok' : 'rounded-md bg-raised-2 px-1.5 py-0.5 font-medium text-ink-2'}>{f.verdict}</span>
            </p>
            <p className="mt-2 text-[14px] leading-snug text-ink">{f.title}</p>
            <p className="mt-1.5 font-mono text-[11.5px] leading-relaxed break-words text-muted">{f.detail}</p>
          </li>
        ))}
      </ul>
      <div className="mt-4 rounded-xl border border-signal/40 bg-sunken/60 px-3.5 py-3">
        <p className="flex items-center justify-between gap-2 text-[12.5px]"><span className="text-ink">Effectiveness · Custom rule “Login watch”</span><span className="font-mono text-faint">Log</span></p>
        <span aria-hidden="true" className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-raised-2"><span className="bg-signal" style={{ width: '100%' }} /></span>
        <p className="mt-2 font-mono text-[11.5px] text-muted">0 blocked · 0 challenged · 29.7k passed · 18.4k bots passed</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[11.5px]">
          <span className="text-faint">Recommended</span><span className="lp-del rounded px-1">Log</span><ArrowRight aria-hidden="true" className="size-3 text-faint" /><span className="lp-add rounded px-1">Managed Challenge</span>
        </p>
      </div>
      <figcaption className="mt-3 text-[11.5px] text-faint">Sample report on example.com. The wording is the audit&apos;s own.</figcaption>
    </figure>
  );
}

// ── 3. Facts (count-up) ─────────────────────────────────────────────────────
function Facts() {
  const facts: { value: number; title: string; body: string }[] = [
    { value: AUDIT_CHECKS, title: 'security-audit checks, no AI', body: 'Transport, origin exposure, email and DNS, WAF, managed rules, bots, rate limits, cache, client-side, API protection, and how each security rule acted on the zone’s traffic.' },
    { value: CHECK_COUNT, title: 'monitoring checks, read-only', body: `${CHECKS.map((c) => c.label).join(', ')}. Each runs on its own schedule, per zone or account, within each token’s rate limit.` },
    { value: CHANGE_CATEGORIES, title: 'categories of Cloudflare changes', body: 'The audit log, sorted into DNS, security rules, cache, SSL/TLS, Zero Trust, API tokens and more, each with the old and new value.' },
    { value: DRILL_LEVELS, title: 'levels of traffic drill-down', body: 'Month, then day, then hour, then minute, each narrowed to its rule hits, top IPs and top paths.' },
    { value: TF_ZONE_TYPES + TF_ACCOUNT_TYPES, title: 'Terraform resource types per backup', body: `${TF_ZONE_TYPES} for each zone and ${TF_ACCOUNT_TYPES} for the account, exported with cf-terraforming. What Terraform can't hold is saved as JSON from the API.` },
    { value: ROLE_COUNT, title: 'roles, enforced on the server', body: ROLES.slice().reverse().map((r) => ROLE_META[r].label).join(', ') + '. Viewers and operators ask for backups, admins approve; an admin’s restore apply waits for a super admin.' },
  ];
  return (
    <section aria-labelledby="facts-title" className="border-y border-line bg-sunken/50">
      <Reveal className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div className="lp-rv grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
          <h2 id="facts-title" className="lp-h2 text-ink">What it covers, in numbers.</h2>
          <p className="lp-copy self-end">What {BRAND.name} checks, reads and keeps for every account and zone your tokens can see. Each number is counted from the code.</p>
        </div>
        <ul className="mt-12 grid gap-x-8 sm:grid-cols-2 xl:grid-cols-3">
          {facts.map((f, n) => (
            <li key={f.title} className="lp-rv border-t border-line pt-6 pb-8" style={i(n)}>
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

// ── 4. Keep it that way: monitoring, changes, investigate ───────────────────
function KeepIt() {
  return (
    <section aria-labelledby="keep-title" className="py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end lg:gap-16">
          <h2 id="keep-title" className="lp-rv lp-h2 text-ink">Fixed it? Keep it that way.</h2>
          <p className="lp-rv lp-copy" style={i(1)}>The audit tells you where a zone stands today. These three watch every account and zone after that, and answer the tickets that follow.</p>
        </Reveal>

        <Reveal className="mt-12 grid gap-4 lg:grid-cols-3" threshold={0.08}>
          {/* Monitoring */}
          <article id="monitoring" aria-labelledby="monitoring-title" className="lp-tile flex scroll-mt-24 flex-col p-6 sm:p-7" style={i(0, { '--tx': '-28px' })}>
            <h3 id="monitoring-title" className="lp-h3 text-ink">Monitoring &amp; zone health</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted">
              {CHECK_COUNT} read-only checks on their own schedules. One health score per zone, drift against the baseline you accepted,
              notifications to Slack or any webhook, Cloudflare&apos;s own alerts, and daily or weekly reports.
            </p>
            <ul className="mt-5 flex flex-wrap gap-1.5" aria-label="Monitoring checks">
              {CHECKS.map((c) => <li key={c.id} className="rounded-md border border-line bg-sunken/70 px-2 py-1 text-[12px] text-ink-2">{c.label}</li>)}
            </ul>
            <div className="mt-auto pt-5">
              <div className="rounded-xl border border-line bg-sunken/70 p-3.5">
                <p className="text-[11.5px] text-faint">Zone health · worst first</p>
                <ul className="mt-2 space-y-1.5 font-mono text-[12.5px]">
                  {[['shop.example.com', 64, 'text-warn'], ['example.net', 78, 'text-warn'], ['example.com', 92, 'text-ok']].map(([z, s, t]) => (
                    <li key={z as string} className="flex justify-between gap-2"><span className="truncate text-ink-2">{z}</span><span className={t as string}>{s}</span></li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] text-faint">Sample scores</p>
              </div>
            </div>
          </article>

          {/* Cloudflare activity & revert */}
          <article id="changes" aria-labelledby="changes-title" className="lp-tile flex scroll-mt-24 flex-col p-6 sm:p-7" style={i(1, { '--ty': '32px' })}>
            <h3 id="changes-title" className="lp-h3 text-ink">Cloudflare activity &amp; revert</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted">
              Every change in each account&apos;s audit log: the old and new value, who made it and when, sorted into {CHANGE_CATEGORIES} categories.
              Admins and super admins can revert one change, with the Global API Key asked each time. Viewers and operators read only.
            </p>
            <div className="mt-auto pt-5">
              <div className="rounded-xl border border-line bg-sunken/70 p-3.5">
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
                <p className="mt-2 text-[11px] text-faint">Sample change</p>
              </div>
            </div>
          </article>

          {/* Investigate */}
          <article id="investigate" aria-labelledby="investigate-title" className="lp-tile flex scroll-mt-24 flex-col p-6 sm:p-7" style={i(2, { '--tx': '28px' })}>
            <h3 id="investigate-title" className="lp-h3 text-ink">Investigate</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted">For the tickets that start with “why was this request blocked?”</p>
            <ul className="mt-4 space-y-2.5 text-[14px] text-ink-2">
              {[
                ['Ray ID lookup', 'the zone, the request and the rule that acted on it'],
                ['URL trace', 'which rules a URL would match, phase by phase, without reaching your origin'],
                ['WAF false positives', 'rules blocking traffic that looks legitimate, with a drafted exception'],
                ['Incident timeline', 'changes, error and block spikes, deployments and certificates on one axis'],
              ].map(([t, b]) => (
                <li key={t} className="flex gap-2.5"><Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-signal" /><span><span className="font-semibold text-ink">{t}:</span> {b}</span></li>
              ))}
            </ul>
            <div className="mt-auto pt-5">
              <div className="rounded-xl border border-line bg-terminal p-3.5 font-mono text-[12px] leading-[1.8] text-ink-2">
                <p className="flex items-center gap-2 text-ink"><Fingerprint aria-hidden="true" className="size-4 text-signal" />8d3f2a1b9c0e4f21-EWR</p>
                <p className="truncate">example.com · POST /login · 403</p>
                <p className="truncate">Custom rule “Block bad ASNs” · block</p>
                <p className="mt-1 text-[11px] text-faint">Sample Ray ID</p>
              </div>
            </div>
          </article>
        </Reveal>
      </div>
    </section>
  );
}

// ── 5. Backup & restore ─────────────────────────────────────────────────────
function BackupRestore() {
  const steps = [
    { title: 'Connect a token', body: 'An account set in the vault: a Cloudflare API token and the R2 or S3 buckets its backups may go to.' },
    { title: 'Back up', body: 'Run it, use a preset, or request one for an admin to approve. Every zone lands as .tf and JSON.' },
    { title: 'Compare', body: 'The newest backup with the zone, planned against the live zone, read-only.' },
    { title: 'Restore', body: 'Apply the reviewed plan; the zone is checked against the backup again and kept in Restore history.' },
  ];
  return (
    <section id="backup" aria-labelledby="backup-title" className="scroll-mt-20 border-t border-line bg-sunken/50 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end lg:gap-16">
          <h2 id="backup-title" className="lp-rv lp-h2 text-ink">The safety net behind every change.</h2>
          <p className="lp-rv lp-copy" style={i(1)}>A copy of every zone and the account, in your own bucket, and a restore that shows you each field before anything is sent to Cloudflare.</p>
        </Reveal>

        <Reveal className="mt-12 grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]" threshold={0.08}>
          <article className="lp-tile flex flex-col p-6 sm:p-8" style={i(0, { '--tx': '-28px' })}>
            <h3 className="lp-h3 text-[1.6rem] text-ink sm:text-[1.9rem]">Backup</h3>
            <p className="lp-copy mt-3">Zones and account settings exported to Terraform (.tf) and JSON and uploaded to the R2 or S3 buckets a super admin approved. Run it now or from a preset; viewers and operators request one, an admin approves it. Run history keeps every run with its live, redacted log.</p>
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

          <article className="lp-tile flex flex-col p-6 sm:p-8" style={i(1, { '--tx': '28px' })}>
            <h3 className="lp-h3 text-[1.6rem] text-ink sm:text-[1.9rem]">Restore</h3>
            <p className="lp-copy mt-3">Put one zone back the way its newest backup has it: only what changed since, or the whole zone. Compare with the live zone, read the plan field by field, then apply.</p>
            <ol className="mt-6 flex flex-wrap items-center gap-1.5 text-[12.5px]">
              {['Compare', 'Plan', 'Apply', 'Verify'].map((s, n) => (
                <li key={s} className="inline-flex items-center gap-1.5">
                  <span className="rounded-md border border-line-strong bg-raised px-2 py-1 text-ink-2">{s}</span>
                  {n < 3 && <ArrowRight aria-hidden="true" className="size-3.5 text-faint" />}
                </li>
              ))}
            </ol>
            <ul className="mt-6 space-y-2.5 text-[14.5px] text-ink-2">
              {['Admins and super admins compare and plan', 'An admin’s apply waits for a super admin', 'The Global API Key is asked at every apply, held in memory only', 'Every restore kept in Restore history, with its plan and log'].map((t) => (
                <li key={t} className="flex gap-2.5"><Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-signal" />{t}</li>
              ))}
            </ul>
          </article>
        </Reveal>

        <div className="mt-16 grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:items-center lg:gap-16">
          <Reveal>
            <h3 className="lp-rv lp-h3 text-[1.6rem] text-ink sm:text-[1.9rem]">Someone switched a WAF rule to log. Put it back.</h3>
            <p className="lp-rv lp-copy mt-4" style={i(1)}>A restore reads the zone as it is now and lists every field that differs from the backup, before anything is sent to Cloudflare.</p>
            <ul className="lp-rv mt-5 space-y-2.5 text-[15px] text-ink-2" style={i(2)}>
              {['Differs: shown field by field, live → backup', 'Deleted: re-created from the backup', 'Not in the backup: offered as a delete, selected'].map((t) => (
                <li key={t} className="flex gap-2.5"><Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-signal" />{t}</li>
              ))}
            </ul>
          </Reveal>
          <DiffSlider />
        </div>

        <Reveal threshold={0.3} className="relative mt-16">
          <span aria-hidden="true" className="lp-rail-track top-5 bottom-12 left-5 w-0.5 lg:top-5 lg:right-auto lg:bottom-auto lg:h-0.5 lg:w-[calc(75%+1.5rem)]" />
          <span aria-hidden="true" className="lp-rail top-5 bottom-12 left-5 w-0.5 lg:top-5 lg:right-auto lg:bottom-auto lg:h-0.5 lg:w-[calc(75%+1.5rem)]" />
          <ol className="relative grid gap-8 lg:grid-cols-4 lg:gap-8" aria-label="From a token to a restored zone">
            {steps.map((s, n) => (
              <li key={s.title} className="grid grid-cols-[2.5rem_1fr] gap-x-5 lg:grid-cols-1" style={i(n)}>
                <span aria-hidden="true" className="lp-stop lp-num relative z-10 grid size-10 place-items-center rounded-full text-[15px]">{n + 1}</span>
                <div className="lp-stop-copy lg:mt-5">
                  <p className="font-semibold text-ink"><span className="sr-only">Step {n + 1}: </span>{s.title}</p>
                  <p className="mt-1.5 max-w-[36ch] text-[14px] leading-relaxed text-muted">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </section>
  );
}

// ── 6. Everything else ──────────────────────────────────────────────────────
function EverythingElse() {
  const groups: { title: string; lede: string; items: { icon: React.ReactNode; name: string; body: string }[] }[] = [
    {
      title: 'Find and compare', lede: 'Answered from stored backups and snapshots, so a question about every zone costs no Cloudflare calls.',
      items: [
        { icon: <Search aria-hidden="true" className="size-4" />, name: 'Search every zone', body: 'An IP or CIDR range, a hostname, a CNAME target, a header or any text in a rule: every zone that uses it, and where.' },
        { icon: <GitCompare aria-hidden="true" className="size-4" />, name: 'Compare', body: 'Two backups of one zone, two zones, or every zone against a template you define. The gaps are listed; nothing is applied.' },
      ],
    },
    {
      title: 'Explore and analyse', lede: 'Everything the token can read, without opening the dashboard zone by zone.',
      items: [
        { icon: <Globe aria-hidden="true" className="size-4" />, name: 'Zone explorer', body: `${ZONE_READS} reads per zone, in the dashboard’s own order: ${ZONE_GROUPS.slice(0, 6).map((g) => g.label).join(', ')} and more. Download as JSON, CSV or DNS as BIND.` },
        { icon: <BarChart3 aria-hidden="true" className="size-4" />, name: 'Traffic analytics', body: 'An account or a zone for a month, down to the minute: cached against origin, threats, what was mitigated and what got through, rule hits, top IPs and paths.' },
        { icon: <Activity aria-hidden="true" className="size-4" />, name: 'DNS & Workers analytics', body: 'DNS queries per zone by name, type and response code; Worker requests, errors and CPU time per account.' },
      ],
    },
    {
      title: 'Lists and logs', lede: 'The pieces that sit between your rules and your logs.',
      items: [
        { icon: <ListFilter aria-hidden="true" className="size-4" />, name: 'IP & ASN lists', body: 'Every IP, ASN, hostname and redirect list, its item count and the account and zone rules that use it.' },
        { icon: <FileOutput aria-hidden="true" className="size-4" />, name: 'Logpush', body: 'Every job’s status: failing, stale or turned off. Job changes ask for an API token with Logs Edit or a Global API Key when they run, never a stored one; an admin’s change waits for a super admin.' },
        { icon: <ScrollText aria-hidden="true" className="size-4" />, name: 'Worker logs', body: 'One Worker’s live requests, console.log lines and exceptions, filtered, without handing out the token. Every role can open it.' },
      ],
    },
    {
      title: 'Operate', lede: 'The few jobs that touch Cloudflare, each behind the roles allowed to do them.',
      items: [
        { icon: <Eraser aria-hidden="true" className="size-4" />, name: 'Cache purge and rollbacks', body: 'Purge by URL, prefix, host or tag, or roll a Worker or Pages project back to an earlier deployment. An admin asks, a super admin approves.' },
        { icon: <Gauge aria-hidden="true" className="size-4" />, name: 'Zone onboarding', body: 'A BIND file compared with the zone before you switch nameservers, then watched until the zone is active.' },
        { icon: <Terminal aria-hidden="true" className="size-4" />, name: 'API console', body: 'Any read-only GET against the Cloudflare API with a stored token, masked and audited, with saved queries.' },
      ],
    },
    {
      title: 'Organise', lede: 'Your own labels on top of Cloudflare’s, and the summaries people actually read.',
      items: [
        { icon: <Tags aria-hidden="true" className="size-4" />, name: 'Zone tags and owners', body: 'Team, environment, customer and owner on every zone, set one by one or from a CSV, as a filter everywhere. Never sent to Cloudflare.' },
        { icon: <Star aria-hidden="true" className="size-4" />, name: 'Favourites and saved views', body: 'Starred and recent zones on the Overview, and a page’s filters saved under a name.' },
        { icon: <FileText aria-hidden="true" className="size-4" />, name: 'Reports and the Slack command', body: 'Daily or weekly summaries to Slack or a webhook, and a read-only /castellan command for zones, findings, search and Ray IDs.' },
      ],
    },
    {
      title: 'Control', lede: 'Who may see, run, approve and change what, on the server.',
      items: [
        { icon: <Users aria-hidden="true" className="size-4" />, name: `${ROLE_COUNT} roles and Approvals`, body: `${ROLES.slice().reverse().map((r) => ROLE_META[r].label).join(', ')}, managed under Users & roles. Backup requests, restore applies, purges, rollbacks and Logpush changes wait on Approvals.` },
        { icon: <KeyRound aria-hidden="true" className="size-4" />, name: 'Encrypted credential vault', body: 'Cloudflare tokens and bucket keys under a separate vault password, for super admins only. Settings cover sessions and the console’s environment.' },
        { icon: <History aria-hidden="true" className="size-4" />, name: 'Audit log and Recent changes', body: 'Every sign-in, vault access, run, approval and permission change, plus a readable list of what changed. Super admins only.' },
      ],
    },
  ];
  return (
    <section id="tools" aria-labelledby="tools-title" className="scroll-mt-20 border-t border-line py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end lg:gap-16">
          <h2 id="tools-title" className="lp-rv lp-h2 text-ink">Everything else, without twenty dashboard tabs.</h2>
          <p className="lp-rv lp-copy" style={i(1)}>The rest of the console: tools for the questions that come up every day across many accounts and zones. Almost all of them only read.</p>
        </Reveal>
        <Reveal className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-3" threshold={0.05}>
          {groups.map((g, n) => (
            <article key={g.title} className="lp-tile p-6 sm:p-7" style={i(n, { '--ty': '24px' })}>
              <h3 className="lp-h3 text-ink">{g.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">{g.lede}</p>
              <ul className="mt-5 space-y-4">
                {g.items.map((it) => (
                  <li key={it.name} className="grid grid-cols-[2rem_1fr] gap-x-3">
                    <span className="mt-0.5 inline-flex size-8 items-center justify-center rounded-lg border border-line bg-sunken/70 text-signal">{it.icon}</span>
                    <span>
                      <span className="block text-[14.5px] font-semibold text-ink">{it.name}</span>
                      <span className="mt-0.5 block text-[13.5px] leading-relaxed text-muted">{it.body}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </Reveal>
        <p className="mt-8 max-w-3xl text-[13.5px] leading-relaxed text-faint">
          The only writes to Cloudflare in the console are a restore apply, a revert, a cache purge, a Worker or Pages rollback and Logpush job changes.
          Each is limited to the roles allowed to make it: when an admin asks for a purge, a rollback, a Logpush change or a restore apply, it waits for a super admin’s approval.
        </p>
      </div>
    </section>
  );
}

// ── 7. Who it's for ─────────────────────────────────────────────────────────
function WhoFor() {
  const cards: { icon: React.ReactNode; title: string; body: string; points: string[] }[] = [
    { icon: <Building2 aria-hidden="true" className="size-5" />, title: 'MSSPs and agencies', body: 'Many customer accounts, one console.', points: ['Every account a token can see, in one place', 'Tags and owners per customer, as a filter everywhere', 'Reports per customer tag, to Slack or a webhook'] },
    { icon: <Workflow aria-hidden="true" className="size-5" />, title: 'Platform and SRE teams', body: 'Change control for an edge many people touch.', points: ['Approvals for restores, purges and rollbacks', 'Drift against an accepted baseline', 'Incident timeline, revert and Worker or Pages rollback'] },
    { icon: <ShieldCheck aria-hidden="true" className="size-5" />, title: 'Security and audit', body: 'Reviews that end with evidence, not screenshots.', points: ['A repeatable audit for quarterly reviews', 'The values behind every finding, and its verdict', 'REPORT.md, CSV and JSON to file with the review'] },
  ];
  return (
    <section aria-labelledby="who-title" className="border-t border-line py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="max-w-3xl">
          <h2 id="who-title" className="lp-rv lp-h2 text-ink">Built for the people who answer for the edge.</h2>
        </Reveal>
        <Reveal className="mt-12 grid gap-4 md:grid-cols-3" threshold={0.1}>
          {cards.map((c, n) => (
            <article key={c.title} className="lp-tile p-6 sm:p-7" style={i(n, { '--ty': '24px' })}>
              <span className="inline-flex size-10 items-center justify-center rounded-lg border border-line bg-sunken/70 text-signal">{c.icon}</span>
              <h3 className="lp-h3 mt-5 text-ink">{c.title}</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{c.body}</p>
              <ul className="mt-5 space-y-2.5 text-[14px] text-ink-2">
                {c.points.map((p) => <li key={p} className="flex gap-2.5"><Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-signal" />{p}</li>)}
              </ul>
            </article>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

const ROLE_BLURB: Record<(typeof ROLES)[number], string> = {
  viewer: 'Reads backups, audits, monitoring, activity and Worker logs; requests backups.',
  operator: 'Also cancels backups and saves presets.',
  admin: 'Approves backups, plans restores, reverts changes with a Global API Key.',
  super_admin: 'The vault, the audit log, and approving admins’ applies and changes.',
};

// ── 8. Us vs them ───────────────────────────────────────────────────────────
function Compare() {
  const rows: { task: string; hand: string; us: string }[] = [
    { task: 'Does my WAF actually work?', hand: 'Exporting security events and lining them up against each rule by hand, one zone at a time.', us: 'Each rule’s blocked, challenged and passed requests for the window, with the bots and malicious requests it let through.' },
    { task: 'Which rules let bots through?', hand: 'Guessing from the Security Events graph.', us: 'The log, skip, allow and challenge rules that let automated or malicious traffic pass, ranked, each with the change that stops it.' },
    { task: 'Keeping a copy', hand: 'Dashboard screenshots, or cf-terraforming run once per resource type, per zone, with the output kept wherever it ran.', us: `One run exports every zone and the account: ${TF_ZONE_TYPES + TF_ACCOUNT_TYPES} resource types to Terraform (it uses cf-terraforming), the rest as JSON, uploaded to an approved bucket.` },
    { task: 'Knowing what changed', hand: 'Reading audit-log entries one JSON object at a time.', us: `Each change with its old and new value, who made it and when, sorted into ${CHANGE_CATEGORIES} categories.` },
    { task: 'Putting it back', hand: 'Writing imports by hand and hoping the plan only touches what you meant.', us: 'Compare with the live zone, read the plan field by field, apply. Or revert one change from the activity log.' },
    { task: 'Who may do what', hand: 'Whoever has the token can do everything the token can.', us: `${ROLE_COUNT} roles enforced on the server, approvals for backups and restores, and an audit log of every action.` },
    { task: 'Traffic questions', hand: 'Opening the analytics of one zone at a time.', us: 'An account or a zone for a month, down to the minute, with rule hits, top IPs and top paths.' },
    { task: 'Where is this used?', hand: 'Opening zone after zone, or a script against the API.', us: 'One search across every zone: DNS, rules, Page Rules, redirects and Worker routes, from stored backups and snapshots.' },
    { task: 'Why was this blocked?', hand: 'Searching security events zone by zone for one Ray ID.', us: 'Paste the Ray ID: the zone, the request and the rule that acted, plus a timeline of what changed around it.' },
  ];
  return (
    <section aria-labelledby="vs-title" className="border-t border-line py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="max-w-3xl">
          <h2 id="vs-title" className="lp-rv lp-h2 text-ink">By hand, or with {BRAND.name}.</h2>
          <p className="lp-rv lp-copy mt-5" style={i(1)}>Many teams keep Cloudflare safe with dashboard clicks and a script someone wrote once. Here is the same work, side by side.</p>
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

// ── 9. Integrations & requirements ──────────────────────────────────────────
function Integrations() {
  const items: { icon: React.ReactNode; name: string; body: string }[] = [
    { icon: <Cloud aria-hidden="true" className="size-4" />, name: 'Cloudflare API', body: 'Read-only API tokens. The more read permissions a token has (Zone, Zone Settings, DNS, SSL and Certificates, Zone WAF, Firewall Services, Account Settings, Analytics, Logs, Workers Scripts …, all Read), the more each page fills in; a missing one is named. Cache purge and rollbacks need their edit permission on the token; restores, reverts and Logpush changes ask for a key when they run.' },
    { icon: <MessageSquare aria-hidden="true" className="size-4" />, name: 'Slack', body: 'An incoming webhook for findings and reports, and the read-only /castellan command.' },
    { icon: <Webhook aria-hidden="true" className="size-4" />, name: 'Webhooks', body: 'Any HTTPS webhook (JSON) for findings and reports, and a webhook destination for Cloudflare’s own alerts.' },
    { icon: <HardDrive aria-hidden="true" className="size-4" />, name: 'Cloudflare R2 or AWS S3', body: 'Your own buckets for backups, approved per account set by a super admin.' },
    { icon: <FileCode2 aria-hidden="true" className="size-4" />, name: 'Terraform and cf-terraforming', body: 'Exports for backups and plans for restores, downloaded on first use and checked against their checksums.' },
    { icon: <Database aria-hidden="true" className="size-4" />, name: 'Supabase', body: 'Your project holds accounts, the vault ciphertext, history, monitoring results and audits.' },
    { icon: <Server aria-hidden="true" className="size-4" />, name: 'Vercel + GitHub Actions, or your own server', body: 'The web side on Vercel with a worker started on GitHub Actions, or one Node.js process or Docker on a machine you control.' },
  ];
  return (
    <section aria-labelledby="int-title" className="border-t border-line bg-sunken/50 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end lg:gap-16">
          <h2 id="int-title" className="lp-rv lp-h2 text-ink">What it connects to, and what it needs.</h2>
          <p className="lp-rv lp-copy" style={i(1)}>No agent on your origin and no change to your DNS. {BRAND.name} talks to Cloudflare’s API with the tokens you give it.</p>
        </Reveal>
        <Reveal as="ul" className="mt-12 grid gap-x-10 sm:grid-cols-2 lg:grid-cols-3" threshold={0.08}>
          {items.map((it, n) => (
            <li key={it.name} className={`lp-rv grid grid-cols-[2rem_1fr] gap-x-3 border-t border-line py-6 ${n === 0 ? 'sm:col-span-2 lg:col-span-3' : ''}`} style={i(n % 3)}>
              <span className="mt-0.5 inline-flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-signal">{it.icon}</span>
              <span>
                <span className="block font-semibold text-ink">{it.name}</span>
                <span className="mt-1 block max-w-[80ch] text-[14.5px] leading-relaxed text-muted">{it.body}</span>
              </span>
            </li>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

// ── 10. Security ────────────────────────────────────────────────────────────
function Security() {
  const items: { title: string; body: string }[] = [
    { title: 'Encrypted vault', body: 'Credentials are sealed with AES-256-GCM under one random 256-bit key. The copy that opens the vault is wrapped with scrypt of a separate vault password. The database only ever holds ciphertext.' },
    { title: 'Secrets stay out of logs', body: 'Backups get their secrets as environment variables, and every log line shows them as ••••••••. Only a super admin with the vault unlocked can reveal one.' },
    { title: 'Reads unless you restore', body: 'Backups, the audit, the explorer, activity, analytics, monitoring, search and the investigation tools only read. During compare and plan, a guard stops any write from reaching Cloudflare. Only an apply, a revert, a cache purge, a rollback or a Logpush change writes.' },
    { title: 'Keys held in memory', body: 'The Global API Key a restore or revert needs, and the key a Logpush change asks for, are kept in the console’s memory only: never on disk, in the database, the audit log or the request.' },
    { title: 'Roles on every request', body: 'Permissions are checked on the server for each call; the interface only hides what a role cannot use. Role changes and password resets sign people out everywhere.' },
    { title: 'Sessions and sign-in', body: 'Idle sessions sign out (30 minutes at most), the vault locks itself, and sign-in can require a Cloudflare Turnstile CAPTCHA.' },
    { title: 'An audit log of everything', body: 'Every sign-in, vault access, credential change, run, audit, approval and permission change is recorded.' },
    { title: 'Locked-down delivery', body: 'HTTPS with HSTS, a strict Content Security Policy, and an allow-list of host names. With a worker, it only connects out: no public URL, open port or tunnel.' },
  ];
  return (
    <section id="security" aria-labelledby="security-title" className="scroll-mt-20 border-t border-line py-20 sm:py-28">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16 lg:px-8">
        <Reveal className="lg:sticky lg:top-28 lg:self-start">
          <h2 id="security-title" className="lp-rv lp-h2 text-ink">It holds the keys to your edge, so it is built that way.</h2>
          <p className="lp-rv lp-copy mt-5" style={i(1)}>The console keeps Cloudflare tokens and bucket keys. Everything below is how this release handles them.</p>
        </Reveal>
        <Reveal threshold={0.1}>
          <dl className="grid gap-x-10 sm:grid-cols-2">
            {items.map((it, n) => (
              <div key={it.title} className="lp-rv border-t border-line py-6" style={i(n % 2)}>
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

// ── 11. Where it runs / plans ───────────────────────────────────────────────
function Plans() {
  const ways = [
    { title: 'Vercel + a worker', body: 'The web side on Vercel; backups, restores and every Cloudflare call on a worker that starts on GitHub Actions when needed.' },
    { title: 'Your own server', body: 'One Node.js process, or Docker, on a machine you control, so tokens can be limited to its fixed IP.' },
  ];
  return (
    <section id="plans" aria-labelledby="plans-title" className="scroll-mt-20 border-t border-line bg-sunken/50 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="grid gap-12 lg:grid-cols-[minmax(0,6fr)_minmax(0,6fr)] lg:gap-16">
          <div>
            <h2 id="plans-title" className="lp-rv lp-h2 text-ink">Plans fitted to how you run Cloudflare.</h2>
            <p className="lp-rv lp-copy mt-5" style={i(1)}>A plan depends on how many accounts and zones you keep, how often you audit and back up, and where the console should run. Tell us about your setup and we will put one together with you.</p>
            <div className="lp-rv mt-8 flex flex-wrap items-center gap-x-5 gap-y-3" style={i(2)}>
              <a href={SALES_HREF} className="lp-btn lp-btn-primary"><Mail aria-hidden="true" className="size-4" />Talk to us</a>
              <a href={SALES_HREF} className="lp-link font-mono text-[14px] text-ink-2 hover:text-ink">{BRAND.salesEmail}</a>
            </div>
          </div>
          <ul className="grid content-start gap-4">
            {ways.map((w, n) => (
              <li key={w.title} className="lp-rv rounded-2xl border border-line p-6" style={i(n + 1)}>
                <p className="lp-h3 text-ink">{w.title}</p>
                <p className="mt-2 text-[15px] leading-relaxed text-muted">{w.body}</p>
              </li>
            ))}
            <li className="lp-rv px-1 text-[13.5px] text-faint" style={i(3)}>Either way, your data stays in your Supabase project and your own buckets.</li>
          </ul>
        </Reveal>
        <Reveal className="mt-14">
          <p className="lp-rv text-[13px] font-semibold text-muted">Roles, enforced on the server</p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {ROLES.slice().reverse().map((r, n) => (
              <li key={r} className="lp-rv rounded-xl border border-line bg-surface p-3.5" style={i(n)}>
                <span className="block text-[13.5px] font-semibold text-ink">{ROLE_META[r].label}</span>
                <span className="mt-1 block text-[12.5px] leading-snug text-muted">{ROLE_BLURB[r]}</span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

// ── 12. FAQ ─────────────────────────────────────────────────────────────────
function Faq() {
  const qa: { q: string; a: string }[] = [
    { q: 'Does the audit use AI?', a: `No. Each of the ${AUDIT_CHECKS} checks is plain code with a documented condition, and each names the attack class it covers. Every finding shows the values it was decided on and whether it is Confirmed or Needs validation.` },
    { q: 'Does the audit change anything?', a: 'No. It reads Cloudflare with the zone’s stored token and needs only read permissions. Fixes are written out as dashboard steps, with drafted expressions where they help, for you to apply yourself.' },
    { q: 'What does the audit read?', a: 'The zone’s configuration through GET requests to Cloudflare’s API: settings, ruleset phases, DNS records and DNSSEC, certificates, IP Access rules, bot, Page Shield and API Shield settings and more. Plus the zone’s security-event analytics for the window you choose: 24 hours, 7 days or 30 days, shortened to what your plan keeps.' },
    { q: 'How is effectiveness measured?', a: 'From Cloudflare’s security events in the window: per rule, the requests it blocked, challenged (and how many solved the challenge) and let through, with top paths, countries and networks. For rules that let traffic pass, bots are counted by bot score 1–29 where your plan has Bot Management, otherwise by non-browser user agents; malicious requests by WAF attack score 1–20, otherwise by threat-like paths or clients other rules stopped. The second kind is marked Needs validation, and fewer than 100 passed requests give no conclusion.' },
    { q: 'Can it audit every zone at once?', a: 'No, on purpose: an audit runs on one zone at a time, so it stays within each token’s rate limit. Every audit is kept, and the list of zones shows each one’s newest audit, worst first.' },
    { q: 'Does it need write access to Cloudflare?', a: 'Not for its everyday work. The audit, backups, the Zone explorer, Cloudflare activity, analytics, monitoring, search and the investigation tools only read. Applying a restore or reverting a change asks for a Global API Key at that moment, and a Logpush change for an API token with Logs Edit or a Global API Key; both are held in memory only. Cache purges and rollbacks need a token that allows them; when an admin asks for one, it waits for a super admin to approve.' },
    { q: 'Will it slow down with thousands of zones?', a: 'It is designed for many zones: search, comparisons, the health score and reports read what is already stored instead of calling Cloudflare. Live reads run on the worker within each token’s rate limit, lists load a page at a time, and nothing refreshes until you ask.' },
    { q: 'Can we label zones by team or customer?', a: 'Yes. Tags, an owner and a contact can be set per zone, one by one or from a CSV, and every list can be filtered by them. They are kept in your Supabase project and never sent to Cloudflare.' },
    { q: 'What exactly is in a backup?', a: `Terraform files for each zone and the account, generated with cf-terraforming across ${TF_ZONE_TYPES + TF_ACCOUNT_TYPES} resource types, plus JSON from Cloudflare’s API for what Terraform cannot express. It is uploaded to your R2 or S3 bucket, and you can download any run as a .zip.` },
    { q: 'Can I restore one zone, or only part of it?', a: 'Restores work one zone at a time. By default only what the audit log says changed since the backup is compared; Compare everything checks the whole zone. You review the plan before anything is applied.' },
    { q: 'Who is allowed to restore or revert?', a: 'Admins and super admins can compare and plan a restore. An admin’s apply waits for a super admin to approve it; super admins apply directly. Reverting a single change from Cloudflare activity is for admins and super admins, with the Global API Key asked each time. Viewers and operators see Cloudflare activity read-only.' },
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

// ── 13. Final CTA ───────────────────────────────────────────────────────────
function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="lp-band">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <Reveal>
          <h2 id="cta-title" className="lp-rv lp-display max-w-5xl text-[clamp(2.3rem,1.3rem+4.4vw,5rem)]">Find out what your rules let through.</h2>
          <div className="lp-rv mt-10 flex flex-wrap items-center gap-3" style={i(1)}>
            <Link href="/console/login" className="lp-btn lp-btn-ink">Sign in <ArrowRight aria-hidden="true" className="size-4" /></Link>
            <a href={SALES_HREF} className="lp-btn lp-btn-outline-ink">Contact sales</a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
