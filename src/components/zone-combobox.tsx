'use client';

import { useEffect, useId, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { cx } from './ui';

// One field to find and choose a zone: type to search, then pick from the list with the mouse or
// the keyboard. Replaces a separate search box over a select. A search that asks the server waits
// for typing to pause; one over zones already in the browser (the zone store) runs on every key.

export interface ZoneChoice { id: string; name: string; sub?: string }

/** How long typing must pause before the zones are searched (a search that asks the server). */
const DEBOUNCE_MS = 200;

export function ZoneCombobox({ value, onChange, search, debounce = DEBOUNCE_MS, label = 'Zone', placeholder = 'Type to search zones…', disabled, id: idIn, className }: {
  value: ZoneChoice | null;
  onChange: (z: ZoneChoice | null) => void;
  /** The zones matching `q` (a page of them) and how many match in all. */
  search: (q: string) => Promise<{ zones: ZoneChoice[]; total: number }>;
  /** Milliseconds typing must pause before `search` runs; 0 when it searches zones already in the browser (no request). */
  debounce?: number;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const auto = useId();
  const id = idIn ?? auto;
  const [typed, setTyped] = useState<string | null>(null);
  const q = typed ?? value?.name ?? '';
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<ZoneChoice[]>([]);
  const [total, setTotal] = useState(0);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || disabled) return;
    let live = true;
    // While a zone is chosen and nothing is typed, the list shows every zone (not just that one).
    const term = typed === null ? '' : typed.trim();
    const run = () => {
      setBusy(true);
      search(term).then((r) => { if (live) { setHits(r.zones); setTotal(r.total); setActive(0); } })
        .catch(() => { if (live) { setHits([]); setTotal(0); } })
        .finally(() => { if (live) setBusy(false); });
    };
    const t = debounce > 0 ? setTimeout(run, debounce) : undefined;
    if (!t) run();
    return () => { live = false; clearTimeout(t); };
  }, [typed, open, disabled, search, debounce]);
  const pick = (z: ZoneChoice) => { onChange(z); setTyped(null); setOpen(false); };
  return (
    <div className={cx('relative', className)}>
      <div className="relative">
        <input id={id} className="input !pr-14" role="combobox" aria-label={label} aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" autoComplete="off"
          aria-activedescendant={open && hits[active] ? `${id}-${hits[active].id}` : undefined}
          placeholder={placeholder} value={q} disabled={disabled}
          onChange={(e) => { setTyped(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => { setOpen(false); setTyped(null); }, 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(hits.length - 1, a + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            else if (e.key === 'Enter' && open && hits[active]) { e.preventDefault(); pick(hits[active]); }
            else if (e.key === 'Escape') { setOpen(false); setTyped(null); }
          }} />
        <span className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-0.5">
          {value && !disabled && (
            <button type="button" className="rounded p-1 text-faint hover:text-ink" aria-label={`Clear ${label}`} onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(null); setTyped(''); }}>
              <X className="size-3.5" />
            </button>
          )}
          <ChevronDown className="pointer-events-none size-4 text-faint" aria-hidden />
        </span>
      </div>
      {open && !disabled && (
        <ul id={`${id}-list`} role="listbox" aria-label={`${label} choices`} className="panel absolute z-20 mt-1 max-h-72 w-full overflow-y-auto py-1 shadow-lg">
          {hits.map((z, i) => (
            <li key={z.id} id={`${id}-${z.id}`} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(z); }}
              className={cx('flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 text-[13px]', i === active ? 'bg-raised text-ink' : 'text-ink-2')}>
              <span className="truncate">{z.name}</span>{z.sub && <span className="shrink-0 truncate text-[11px] text-faint">{z.sub}</span>}
            </li>
          ))}
          {!hits.length && <li className="px-3 py-1.5 text-[12px] text-muted">{busy ? 'Searching…' : 'No zone matches'}</li>}
          {total > hits.length && <li className="px-3 py-1.5 text-[11px] text-faint">{total - hits.length} more — keep typing</li>}
        </ul>
      )}
    </div>
  );
}
