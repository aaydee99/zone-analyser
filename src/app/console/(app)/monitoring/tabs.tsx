'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMe } from '@/components/me';
import { cx } from '@/components/ui';
import { CHECKS } from '@/lib/monitor-types';

/** The monitoring pages: the overview, then one tab per check the user may see. */
export function MonitorTabs() {
  const path = usePathname();
  const { can } = useMe();
  const tabs = [{ href: '/console/monitoring', label: 'Overview' }, ...CHECKS.filter((c) => can(c.perm)).map((c) => ({ href: `/console/monitoring/${c.id}`, label: c.label }))];
  return (
    <nav aria-label="Monitoring" className="-mx-1 mb-6 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-line px-1">
        {tabs.map((t) => {
          const on = path === t.href;
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={on ? 'page' : undefined}
                className={cx('relative block px-3 py-2.5 text-[13px] whitespace-nowrap transition-colors', on ? 'text-ink' : 'text-muted hover:text-ink-2')}>
                {t.label}
                {on && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-signal" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
