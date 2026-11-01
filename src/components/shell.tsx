'use client';

import Link from 'next/link';
import { BRAND } from '@/lib/brand';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BrandMark } from './brand-mark';
import { Eraser, FileOutput, ShieldAlert, FileText, Fingerprint, GitCompare, HeartPulse, ListFilter, MessageSquare, Radar, Search, Tags, Terminal, ScanSearch } from 'lucide-react';
import { ZoneSearchBox } from './zone-search-box';
import { Activity, BarChart3, Cloud, DatabaseBackup, ShieldCheck, Globe, FileClock, History, KeyRound, LayoutGrid, LogOut, Menu, RotateCcw, ScrollText, Settings2, UserCog, Users, X, Lock } from 'lucide-react';
import { api } from '@/lib/client';
import { ROLE_META, type Permission } from '@/lib/rbac';
import { cx } from './ui';
import { MeProvider, type MeState } from './me';
import { WorkerStarting } from './worker-starting';
import { useFocusTrap } from './use-focus-trap';
import { usePoll } from './use-poll';

/** perm hides the item without it; locked shows it to everyone, with a lock for those who cannot use it. */
interface NavItem { href: string; label: string; icon: typeof LayoutGrid; perm?: Permission; locked?: Permission }

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Backups',
    items: [
      { href: '/console', label: 'Overview', icon: LayoutGrid },
      { href: '/console/backup', label: 'New backup', icon: DatabaseBackup, perm: 'runs:start' },
      { href: '/console/runs', label: 'Run history', icon: History },
    ],
  },
  {
    section: 'Restore',
    items: [
      { href: '/console/restore', label: 'Overview', icon: LayoutGrid, perm: 'restore:run' },
      { href: '/console/restore/new', label: 'New restore', icon: RotateCcw, perm: 'restore:run' },
      { href: '/console/restore/history', label: 'Restore history', icon: History, perm: 'restore:run' },
    ],
  },
  {
    section: 'Approvals',
    items: [
      { href: '/console/approvals', label: 'Approvals', icon: ShieldCheck, perm: 'runs:start' },
    ],
  },
  {
    section: 'Monitoring',
    items: [
      { href: '/console/monitoring', label: 'Monitoring', icon: Radar },
      { href: '/console/health', label: 'Zone health', icon: HeartPulse },
      { href: '/console/reports', label: 'Reports', icon: FileText },
    ],
  },
  {
    section: 'Find & investigate',
    items: [
      { href: '/console/search', label: 'Search', icon: Search },
      { href: '/console/compare', label: 'Compare', icon: GitCompare },
      { href: '/console/investigate', label: 'Investigate', icon: Fingerprint },
      { href: '/console/security-audit', label: 'Security audit', icon: ShieldAlert },
    ],
  },
  {
    section: 'Cloudflare',
    items: [
      { href: '/console/zone-explorer', label: 'Zone explorer', icon: Globe },
      { href: '/console/traffic', label: 'Traffic analytics', icon: BarChart3 },
      { href: '/console/analytics', label: 'DNS & Workers', icon: Activity },
      { href: '/console/cloudflare-activity', label: 'Cloudflare activity', icon: Cloud, perm: 'activity:read' },
      { href: '/console/purge', label: 'Cache purge', icon: Eraser, locked: 'cloudflare:act' },
      { href: '/console/lists', label: 'IP & ASN lists', icon: ListFilter },
      { href: '/console/logpush', label: 'Logpush', icon: FileOutput },
      { href: '/console/onboarding', label: 'Zone onboarding', icon: ScanSearch },
      { href: '/console/zones/tags', label: 'Zone tags', icon: Tags },
    ],
  },
  {
    section: 'Tools',
    items: [
      { href: '/console/tools/api', label: 'API console', icon: Terminal, locked: 'cloudflare:query' },
      { href: '/console/tools/worker-logs', label: 'Worker logs', icon: ScrollText, perm: 'workers:tail' },
    ],
  },
  {
    section: 'Configuration',
    items: [
      { href: '/console/vault', label: 'Credentials', icon: KeyRound, perm: 'vault:access' },
      { href: '/console/settings', label: 'Settings', icon: Settings2, perm: 'settings:read' },
      { href: '/console/settings/slack', label: 'Slack command', icon: MessageSquare, perm: 'settings:read' },
    ],
  },
  {
    section: 'Access',
    items: [
      { href: '/console/users', label: 'Users & roles', icon: Users, perm: 'users:manage' },
      { href: '/console/changes', label: 'Recent changes', icon: FileClock, perm: 'audit:read' },
      { href: '/console/audit', label: 'Audit log', icon: ScrollText, perm: 'audit:read' },
    ],
  },
];

const initials = (name: string, email: string) => (name || email)
  .split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-8 place-items-center rounded-[9px] border border-line-strong/70 bg-terminal">
        <BrandMark className="h-[17px]" />
      </div>
      <div className="leading-tight">
        <div className="text-[14px] font-semibold tracking-tight">{BRAND.name}</div>
        <div className="font-mono text-[10.5px] text-muted">console</div>
      </div>
    </div>
  );
}

/** "signing out in m:ss if idle" in the last 10 minutes; re-renders only itself, every second only then. */
function IdleCountdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  const remaining = Math.max(0, expiresAt - now);
  const near = remaining < 10 * 60_000;
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const t = near ? setInterval(tick, 1000) : undefined;
    const wait = near ? undefined : setTimeout(tick, Math.min(expiresAt - Date.now() - 10 * 60_000 + 50, 2 ** 31 - 1));
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(t); clearTimeout(wait); document.removeEventListener('visibilitychange', tick); };
  }, [expiresAt, near]);
  if (!near) return null;
  const mm = Math.floor(remaining / 60000);
  const ss = Math.floor((remaining % 60000) / 1000);
  return (
    <div className="mt-2 font-mono text-[11px] text-warn">
      signing out in {mm}:{String(ss).padStart(2, '0')} if idle
    </div>
  );
}

/** Same answer as before (compared as JSON): keep the old object, so useMe() users do not re-render. */
const same = (a: MeState, b: MeState) => JSON.stringify(a) === JSON.stringify(b);

export function Shell({ initial, children }: { initial: MeState; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<MeState>(initial);
  const [mobileOpen, setMobileOpen] = useState(false);
  const lastTouch = useRef(0);

  // A 401 from api() already sends the browser to /login.
  const refresh = useCallback(async (touch = false, signal?: AbortSignal) => {
    try { const next = await api<MeState>(`/api/auth/me${touch ? '' : '?peek=1'}`, { signal }); setMe((m) => (same(m, next) ? m : next)); } catch { /* transient */ }
  }, []);
  const peek = useCallback((signal: AbortSignal) => refresh(false, signal), [refresh]);
  const touchRefresh = useCallback(() => { refresh(true); }, [refresh]);

  // Background poll does not count as activity; real input does (throttled).
  // Faster while a job runs, so its banner (and the pages' start buttons) follow it closely.
  // Refresh often while something changes: a job runs, or the worker is starting.
  const jobRunning = !!(me.activeRunId || me.activeRestore || (me.worker && !me.worker.online && me.worker.startingSince));
  // The poll pauses while the tab is hidden (nobody sees the banner) and refreshes once when it is shown again.
  usePoll(peek, jobRunning ? 4_000 : 20_000, { now: false });
  useEffect(() => {
    const onActivity = () => {
      if (Date.now() - lastTouch.current > 45_000) { lastTouch.current = Date.now(); refresh(true); }
    };
    window.addEventListener('pointerdown', onActivity);
    window.addEventListener('keydown', onActivity);
    return () => { window.removeEventListener('pointerdown', onActivity); window.removeEventListener('keydown', onActivity); };
  }, [refresh]);

  // Rendered without the live state (it was slow): ask for it now.
  useEffect(() => { if (initial.stale) void refresh(false); }, [initial.stale, refresh]);
  useEffect(() => { setMobileOpen(false); }, [pathname]);
  const mobileMenu = useRef<HTMLElement>(null);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  useFocusTrap(mobileMenu, mobileOpen, closeMobile);

  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    router.replace('/console/login');
  };

  const perms = new Set(me.permissions);
  // The most specific nav item wins: /restore/new lights "New restore", not also the Restore overview.
  const hrefs = NAV.flatMap((s) => s.items.map((i) => i.href));
  const matches = (href: string) => (href === '/console' ? pathname === '/console' : pathname === href || pathname.startsWith(`${href}/`));
  const isActive = (href: string) => matches(href) && !hrefs.some((h) => h !== href && h.startsWith(`${href}/`) && matches(h));
  const nav = NAV.map(({ section, items }) => ({ section, items: items.filter((i) => !i.perm || perms.has(i.perm)) })).filter((s) => s.items.length);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="px-5 pt-5 pb-4"><Logo /></div>
      <div className="px-3 pb-4"><ZoneSearchBox /></div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3">
        {nav.map(({ section, items }) => (
          <div key={section}>
            <div className="eyebrow mb-1.5 px-3 !text-[10.5px] !text-faint">{section}</div>
            <div className="space-y-0.5">
              {items.map(({ href, label, icon: Icon, locked }) => (
                <Link
                  key={href}
                  href={href}
                  aria-current={isActive(href) ? 'page' : undefined}
                  className={cx(
                    'group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] transition-colors duration-200',
                    isActive(href) ? 'bg-raised text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink-2',
                  )}
                >
                  {isActive(href) && <span className="absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-r bg-signal" />}
                  <Icon className={cx('size-[17px]', isActive(href) ? 'text-signal' : 'text-faint group-hover:text-muted')} />
                  {label}
                  {locked && !perms.has(locked) && <Lock className="ml-auto size-3.5 text-faint" aria-label="View only: your role cannot use this" />}
                  {href === '/console/approvals' && !!me.pendingApprovals && (
                    <span className="ml-auto rounded-full bg-signal px-1.5 py-px text-[11px] font-semibold tabular-nums text-canvas" aria-label={`${me.pendingApprovals} waiting for you`}>{me.pendingApprovals}</span>
                  )}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {me.activeRunId && (
        <Link href={`/console/runs/${me.activeRunId}`} className="mx-3 mb-3 flex items-center gap-3 rounded-xl border border-live/30 bg-live/[0.07] px-3 py-2.5 text-[13px] transition-colors hover:bg-live/[0.12]">
          <span className="live-dot size-2 rounded-full bg-live" />
          <span className="flex-1">
            <span className="block font-medium text-ink">Backup running</span>
            <span className="text-xs text-muted">View live log</span>
          </span>
          <Activity className="size-4 text-live" aria-hidden />
        </Link>
      )}
      {me.activeRestore && (
        <Link href="/console/restore/new" className="mx-3 mb-3 flex items-center gap-3 rounded-xl border border-live/30 bg-live/[0.07] px-3 py-2.5 text-[13px] transition-colors hover:bg-live/[0.12]">
          <span className="live-dot size-2 rounded-full bg-live" />
          <span className="flex-1">
            <span className="block font-medium text-ink">Restore running</span>
            <span className="text-xs text-muted">{me.activeRestore.zone} · {me.activeRestore.job}</span>
          </span>
          <Activity className="size-4 text-live" aria-hidden />
        </Link>
      )}

      <div className="m-3 rounded-xl border border-line bg-sunken p-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-raised-2 font-mono text-[11px] font-semibold text-ink-2" aria-hidden>
            {initials(me.user.name, me.user.email)}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-medium text-ink" title={me.user.email}>{me.user.name || me.user.email}</div>
            <div className={cx('text-[11px]', me.user.role === 'super_admin' ? 'text-signal' : 'text-muted')}>{ROLE_META[me.user.role].label}</div>
          </div>
        </div>
        <div className="mt-2.5 flex gap-1.5">
          <Link href="/console/account" className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-line-strong px-2 py-1.5 text-xs text-ink-2 transition-colors hover:border-faint hover:text-ink">
            <UserCog className="size-3.5" aria-hidden /> Account
          </Link>
          <button onClick={signOut} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-line-strong px-2 py-1.5 text-xs text-ink-2 transition-colors hover:border-faint hover:text-ink">
            <LogOut className="size-3.5" aria-hidden /> Sign out
          </button>
        </div>
        {!!me.expiresAt && <IdleCountdown expiresAt={me.expiresAt} />}
      </div>
    </div>
  );

  return (
    <MeProvider value={me} refresh={touchRefresh}>
      <div className="flex min-h-screen">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-lg focus:bg-signal focus:px-4 focus:py-2 focus:font-semibold focus:text-signal-ink">
          Skip to content
        </a>
        <aside className="glass sticky top-0 hidden h-screen w-[248px] shrink-0 border-r border-line lg:block">{sidebar}</aside>

        {mobileOpen && (
          <div className="fixed inset-0 z-40 bg-canvas/70 backdrop-blur-sm lg:hidden" onClick={() => setMobileOpen(false)}>
            <aside ref={mobileMenu} id="mobile-menu" tabIndex={-1} role="dialog" aria-modal aria-label="Menu" className="h-full w-[260px] border-r border-line bg-surface outline-none" onClick={(e) => e.stopPropagation()}>{sidebar}</aside>
          </div>
        )}

        <div className="min-w-0 flex-1">
          <header className="glass sticky top-0 z-30 flex items-center justify-between border-b border-line px-4 py-3 lg:hidden">
            <Logo />
            <button onClick={() => setMobileOpen((v) => !v)} className="rounded-md p-2.5 text-ink-2 transition-colors hover:bg-raised" aria-label="Menu" aria-expanded={mobileOpen} aria-controls="mobile-menu">
              {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </header>
          <main id="main" className="mx-auto w-full max-w-[1240px] px-4 py-8 sm:px-8 lg:py-10">
            {/* Development mode shows stack traces in the browser and loosens the CSP: never for real use. */}
            {process.env.NODE_ENV !== 'production' && me.permissions.includes('settings:read') && (
              <div role="alert" className="mb-6 rounded-xl border border-warn/40 bg-warn/[0.07] px-4 py-3 text-[13px]">
                <b className="text-warn">Running in development mode.</b> Errors show stack traces in the browser and the security policy is relaxed. For real use, run <span className="font-mono">npm run build</span> then <span className="font-mono">npm start</span>.
              </div>
            )}
            {me.worker?.online && me.worker.updating && (
              <div role="status" className="mb-6 rounded-xl border border-info/40 bg-info/[0.07] px-4 py-3 text-[13px]">
                <b className="text-info">Updating the worker.</b> A newer version of the console is deployed: the worker restarts with it as soon as nothing is running (about 3 minutes once it stops).
              </div>
            )}
            {me.worker && !me.worker.online && (me.worker.startingSince ? (
              <WorkerStarting w={me.worker} />
            ) : (
              <div role="alert" className="mb-6 rounded-xl border border-bad/40 bg-bad/[0.07] px-4 py-3 text-[13px]">
                <b className="text-bad">The worker is offline.</b> Backups, restores, the vault and Cloudflare reads run on the worker, so they wait until it is back.{' '}
                {me.worker.lastSeen ? `Last seen ${new Date(me.worker.lastSeen).toLocaleString()}.` : 'It has never started.'}{' '}
                {me.worker.onDemand ? 'Starting it on GitHub Actions did not work: see Vercel › Logs, and the README (Worker).' : 'Set up starting it on GitHub Actions (README, Worker).'}
              </div>
            ))}
            {children}
          </main>
        </div>
      </div>
    </MeProvider>
  );
}
