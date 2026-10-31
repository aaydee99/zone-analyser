'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/components/ui';

const TABS = [
  { href: '/console/investigate/ray', label: 'Ray ID lookup' },
  { href: '/console/investigate/trace', label: 'URL trace' },
  { href: '/console/investigate/waf', label: 'WAF false positives' },
  { href: '/console/investigate/timeline', label: 'Zone timeline' },
];

/** The investigation tools, one tab each. */
export function InvestigateTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Investigate" className="-mx-1 mb-6 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-line px-1">
        {TABS.map((t) => {
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
