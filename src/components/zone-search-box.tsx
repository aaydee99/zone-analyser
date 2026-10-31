'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { cx } from './ui';

/**
 * A compact "search every zone" box (for the header): it opens /console/search with what was typed.
 * Nothing is fetched here, so it costs nothing until someone searches.
 */
export function ZoneSearchBox({ className, autoFocus }: { className?: string; autoFocus?: boolean }) {
  const router = useRouter();
  const id = useId();
  const [q, setQ] = useState('');
  return (
    <form role="search" className={cx('relative block w-full max-w-xs', className)}
      onSubmit={(e) => { e.preventDefault(); const t = q.trim(); if (t) router.push(`/console/search?q=${encodeURIComponent(t)}`); }}>
      <label htmlFor={id} className="sr-only">Search every zone</label>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
      <input id={id} type="search" className="input !py-1.5 !pl-8 !text-[13px]" placeholder="Search zones: IP, host, header…" value={q} maxLength={200}
        autoFocus={autoFocus} onChange={(e) => setQ(e.target.value)} />
    </form>
  );
}
