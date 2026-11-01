'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api, relTime } from '@/lib/client';
import { Button, cx } from '@/components/ui';
import type { IndexedZone } from '@/lib/compare';

// Shared pieces of the comparison pages: the tabs, a zone picker and paging.

const TABS = [
  { href: '/console/compare/backups', label: 'Backup vs backup' },
  { href: '/console/compare/zones', label: 'Zone vs zone' },
  { href: '/console/compare/templates', label: 'Templates' },
];

export function CompareTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Comparisons" className="-mx-1 mb-6 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-line px-1">
        {TABS.map((t) => {
          const on = path === t.href || path.startsWith(`${t.href}/`);
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

/** Waits until `value` has stopped changing for `ms`. */
function useSettled<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/**
 * Picks a zone with stored configuration: type part of its name, then choose it in the list. Zones are
 * looked up once typing stops (at most 50 at a time).
 */
export function ZonePicker({ label, value, onChange }: { label: string; value: { id: string; name: string } | null; onChange: (z: { id: string; name: string } | null) => void }) {
  const id = useId();
  const [q, setQ] = useState('');
  const term = useSettled(q.trim());
  const [zones, setZones] = useState<IndexedZone[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!term) { setZones(null); return; }
    let live = true;
    api<{ zones: IndexedZone[] }>(`/api/compare/zones?q=${encodeURIComponent(term)}`).then((r) => { if (live) { setZones(r.zones); setError(''); } }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [term]);
  return (
    <div className="space-y-1.5">
      <label htmlFor={`${id}-q`} className="flex items-center gap-2 text-[13px] font-medium text-ink-2">{label}</label>
      {value ? (
        <div className="flex items-center justify-between gap-2 rounded-[10px] border border-line-strong bg-raised px-3 py-2 text-sm">
          <span className="truncate font-medium">{value.name}</span>
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Change</Button>
        </div>
      ) : (
        <>
          <input id={`${id}-q`} className="input" type="search" placeholder="Type part of the zone name" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
          {error && <p className="text-xs text-bad">{error}</p>}
          {zones && (zones.length ? (
            <ul aria-label={`Zones matching ${term}`} className="max-h-56 overflow-y-auto rounded-[10px] border border-line">
              {zones.map((z) => (
                <li key={z.zoneId}>
                  <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[13px] hover:bg-raised" onClick={() => { onChange({ id: z.zoneId, name: z.zoneName }); setQ(''); }}>
                    <span className="truncate">{z.zoneName}</span>
                    <span className="shrink-0 text-[11px] text-faint">{z.sources.map((s) => s.source.replace(/^monitor:/, '')).join(', ')} · {relTime(z.sources.map((s) => s.at).sort().pop())}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="text-xs text-muted">No zone with stored data matches.</p>)}
        </>
      )}
    </div>
  );
}

import { whole } from '@/lib/num';

export function Pager({ offset, limit, shown, total, onPage }: { offset: number; limit: number; shown: number; total: number; onPage: (offset: number) => void }) {
  if (!total) return null;
  const end = offset + shown;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-[12px] text-muted">
      <span>{(offset + 1).toLocaleString('en-US')}–{end.toLocaleString('en-US')} of {whole.format(total)}</span>
      <span className="flex gap-2">
        <Button size="sm" variant="ghost" disabled={!offset} onClick={() => onPage(Math.max(0, offset - limit))}>Previous</Button>
        <Button size="sm" variant="ghost" disabled={end >= total} onClick={() => onPage(end)}>Next</Button>
      </span>
    </div>
  );
}

/** A value list in a table cell ("—" when empty). */
export function Values({ v }: { v: (string | null)[] }) {
  const list = v.filter((x): x is string => x !== null);
  if (!list.length) return <span className="text-faint">—</span>;
  return <span className="font-mono text-[12px] break-all whitespace-pre-wrap text-ink-2">{list.map((x) => (x.length > 400 ? `${x.slice(0, 400)}…` : x)).join('\n')}</span>;
}
