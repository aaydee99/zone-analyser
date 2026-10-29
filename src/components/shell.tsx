'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, Cloud, DatabaseBackup, ShieldCheck, Globe, FileClock, History, KeyRound, LayoutGrid, LogOut, Menu, RotateCcw, ScrollText, Settings2, UserCog, Users, X } from 'lucide-react';
import { api } from '@/lib/client';
import { ROLE_META, type Permission } from '@/lib/rbac';
import { cx } from './ui';
import { MeProvider, type MeState } from './me';

interface NavItem { href: string; label: string; icon: typeof LayoutGrid; perm?: Permission }

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Backups',
    items: [
      { href: '/', label: 'Overview', icon: LayoutGrid },
      { href: '/backup', label: 'New backup', icon: DatabaseBackup, perm: 'runs:start' },
      { href: '/runs', label: 'Run history', icon: History },
    ],
  },
  {
    section: 'Restore',
    items: [
      { href: '/restore', label: 'Overview', icon: LayoutGrid, perm: 'restore:run' },
      { href: '/restore/new', label: 'New restore', icon: RotateCcw, perm: 'restore:run' },
      { href: '/restore/history', label: 'Restore history', icon: History, perm: 'restore:run' },
    ],
  },
  {
    section: 'Approvals',
    items: [
      { href: '/approvals', label: 'Approvals', icon: ShieldCheck, perm: 'runs:start' },
    ],
  },
  {
    section: 'Cloudflare',
    items: [
      { href: '/zone-explorer', label: 'Zone explorer', icon: Globe },
      { href: '/cloudflare-activity', label: 'Cloudflare activity', icon: Cloud, perm: 'audit:read' },
    ],
  },
  {
    section: 'Configuration',
    items: [
      { href: '/vault', label: 'Credentials', icon: KeyRound, perm: 'vault:access' },
      { href: '/settings', label: 'Settings', icon: Settings2, perm: 'settings:read' },
    ],
  },
  {
    section: 'Access',
    items: [
      { href: '/users', label: 'Users & roles', icon: Users, perm: 'users:manage' },
      { href: '/changes', label: 'Recent changes', icon: FileClock, perm: 'audit:read' },
      { href: '/audit', label: 'Audit log', icon: ScrollText, perm: 'audit:read' },
    ],
  },
];

const initials = (name: string, email: string) => (name || email)
  .split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative grid size-8 place-items-center rounded-[9px] bg-gradient-to-br from-signal-soft to-signal text-signal-ink shadow-[0_6px_20px_-8px_var(--color-signal)]">
        <DatabaseBackup className="size-[17px]" strokeWidth={2.2} />
      </div>
      <div className="leading-tight">
        <div className="text-[14px] font-semibold tracking-tight">Backup Console</div>
        <div className="font-mono text-[10.5px] text-muted">cloudflare · terraform</div>
      </div>
    </div>
  );
}

export function Shell({ initial, children }: { initial: MeState; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<MeState>(initial);
  const [now, setNow] = useState(() => Date.now());
  const [mobileOpen, setMobileOpen] = useState(false);
  const lastTouch = useRef(0);

  // A 401 from api() already sends the browser to /login.
  const refresh = useCallback(async (touch = false) => {
    try { setMe(await api<MeState>(`/api/auth/me${touch ? '' : '?peek=1'}`)); } catch { /* transient */ }
  }, []);
  const touchRefresh = useCallback(() => { refresh(true); }, [refresh]);

  // Background poll does not count as activity; real input does (throttled).
  // Faster while a job runs, so its banner (and the pages' start buttons) follow it closely.
  const jobRunning = !!(me.activeRunId || me.activeRestore);
  useEffect(() => {
    const poll = setInterval(() => refresh(false), jobRunning ? 4_000 : 20_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onActivity = () => {
      if (Date.now() - lastTouch.current > 45_000) { lastTouch.current = Date.now(); refresh(true); }
    };
    window.addEventListener('pointerdown', onActivity);
    window.addEventListener('keydown', onActivity);
    return () => { clearInterval(poll); clearInterval(tick); window.removeEventListener('pointerdown', onActivity); window.removeEventListener('keydown', onActivity); };
  }, [refresh, jobRunning]);

  useEffect(() => { setMobileOpen(false); }, [pathname]);

  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    router.replace('/login');
  };

  const perms = new Set(me.permissions);
  const remaining = me.expiresAt ? Math.max(0, me.expiresAt - now) : null;
  const mm = remaining !== null ? Math.floor(remaining / 60000) : 0;
  const ss = remaining !== null ? Math.floor((remaining % 60000) / 1000) : 0;
  // The most specific nav item wins: /restore/new lights "New restore", not also the Restore overview.
  const hrefs = NAV.flatMap((s) => s.items.map((i) => i.href));
  const matches = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));
  const isActive = (href: string) => matches(href) && !hrefs.some((h) => h !== href && h.startsWith(`${href}/`) && matches(h));
  const nav = NAV.map(({ section, items }) => ({ section, items: items.filter((i) => !i.perm || perms.has(i.perm)) })).filter((s) => s.items.length);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="px-5 pt-5 pb-6"><Logo /></div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3">
        {nav.map(({ section, items }) => (
          <div key={section}>
            <div className="eyebrow mb-1.5 px-3 !text-[10.5px] !text-faint">{section}</div>
            <div className="space-y-0.5">
              {items.map(({ href, label, icon: Icon }) => (
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
                  {href === '/approvals' && !!me.pendingApprovals && (
                    <span className="ml-auto rounded-full bg-signal px-1.5 py-px text-[11px] font-semibold tabular-nums text-canvas" aria-label={`${me.pendingApprovals} waiting for you`}>{me.pendingApprovals}</span>
                  )}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {me.activeRunId && (
        <Link href={`/runs/${me.activeRunId}`} className="mx-3 mb-3 flex items-center gap-3 rounded-xl border border-live/30 bg-live/[0.07] px-3 py-2.5 text-[13px] transition-colors hover:bg-live/[0.12]">
          <span className="live-dot size-2 rounded-full bg-live" />
          <span className="flex-1">
            <span className="block font-medium text-ink">Backup running</span>
            <span className="text-xs text-muted">View live log</span>
          </span>
          <Activity className="size-4 text-live" aria-hidden />
        </Link>
      )}
      {me.activeRestore && (
        <Link href="/restore/new" className="mx-3 mb-3 flex items-center gap-3 rounded-xl border border-live/30 bg-live/[0.07] px-3 py-2.5 text-[13px] transition-colors hover:bg-live/[0.12]">
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
          <Link href="/account" className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-line-strong px-2 py-1.5 text-xs text-ink-2 transition-colors hover:border-faint hover:text-ink">
            <UserCog className="size-3.5" aria-hidden /> Account
          </Link>
          <button onClick={signOut} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-line-strong px-2 py-1.5 text-xs text-ink-2 transition-colors hover:border-faint hover:text-ink">
            <LogOut className="size-3.5" aria-hidden /> Sign out
          </button>
        </div>
        {remaining !== null && remaining < 10 * 60_000 && (
          <div className="mt-2 font-mono text-[11px] text-warn">
            signing out in {mm}:{String(ss).padStart(2, '0')} if idle
          </div>
        )}
      </div>
    </div>
  );

  return (
    <MeProvider value={me} refresh={touchRefresh}>
      <div className="flex min-h-screen">
        <aside className="glass sticky top-0 hidden h-screen w-[248px] shrink-0 border-r border-line lg:block">{sidebar}</aside>

        {mobileOpen && (
          <div className="fixed inset-0 z-40 bg-canvas/70 backdrop-blur-sm lg:hidden" onClick={() => setMobileOpen(false)}>
            <aside className="h-full w-[260px] border-r border-line bg-surface" onClick={(e) => e.stopPropagation()}>{sidebar}</aside>
          </div>
        )}

        <div className="min-w-0 flex-1">
          <header className="glass sticky top-0 z-30 flex items-center justify-between border-b border-line px-4 py-3 lg:hidden">
            <Logo />
            <button onClick={() => setMobileOpen((v) => !v)} className="rounded-md p-2.5 text-ink-2 transition-colors hover:bg-raised" aria-label="Menu" aria-expanded={mobileOpen}>
              {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </header>
          <main className="mx-auto w-full max-w-[1240px] px-4 py-8 sm:px-8 lg:py-10">
            {/* Development mode shows stack traces in the browser and loosens the CSP: never for real use. */}
            {process.env.NODE_ENV !== 'production' && me.permissions.includes('settings:read') && (
              <div role="alert" className="mb-6 rounded-xl border border-warn/40 bg-warn/[0.07] px-4 py-3 text-[13px]">
                <b className="text-warn">Running in development mode.</b> Errors show stack traces in the browser and the security policy is relaxed. For real use, run <span className="font-mono">npm run build</span> then <span className="font-mono">npm start</span>.
              </div>
            )}
            {me.worker && !me.worker.online && (
              <div role="alert" className="mb-6 rounded-xl border border-bad/40 bg-bad/[0.07] px-4 py-3 text-[13px]">
                <b className="text-bad">The worker is offline.</b> Backups, restores, the vault and Cloudflare reads run on the worker, so they wait until it is back.{' '}
                {me.worker.lastSeen ? `Last seen ${new Date(me.worker.lastSeen).toLocaleString()}.` : 'It has never started.'} Start it with <span className="font-mono">npm run worker</span> or <span className="font-mono">docker compose up -d</span> (README, Worker).
              </div>
            )}
            {children}
          </main>
        </div>
      </div>
    </MeProvider>
  );
}
