'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import type { InvestigatePending } from '@/lib/investigate-types';
import { Button, Loading, SkeletonTable, cx } from '@/components/ui';

// Pieces the investigation pages share: a read that runs in the background (asked once; while the
// server answers "still reading", it asks again every 3 seconds until the result is there — then
// nothing more until Refresh), its progress, and the zone / account pickers (searched on the server,
// so the browser never holds all 6,000+ zones).

/** Reads `path` once (null: nothing yet). `reload(true)` reads again from Cloudflare (&fresh=1). */
export function useJob<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [pending, setPending] = useState<InvestigatePending | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<string | null>(null);
  /** The read now shown; an older one stops when a new one starts or the page is left. */
  const current = useRef<{ live: boolean } | null>(null);
  const run = useCallback(async (p: string, fresh: boolean, ctl: { live: boolean }) => {
    if (current.current) current.current.live = false;
    current.current = ctl;
    setBusy(true); setError(''); setPending(null); setData(null);
    try {
      for (let job = ''; ;) {
        const sep = p.includes('?') ? '&' : '?';
        const r = await api<T | InvestigatePending>(`${p}${fresh && !job ? `${sep}fresh=1` : ''}${job ? `${sep}job=${encodeURIComponent(job)}` : ''}`);
        if (!ctl.live) return;
        if (r && typeof r === 'object' && 'pending' in r) {
          setPending(r); job = r.job;
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          if (!ctl.live) return;
          continue;
        }
        setData(r as T); setPending(null); setAt(new Date().toISOString());
        break;
      }
    } catch (e) {
      if (ctl.live) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (ctl.live) setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!path) return;
    const ctl = { live: true };
    queueMicrotask(() => { if (ctl.live) void run(path, false, ctl); });
    // Left or changed: the loop ends.
    return () => { ctl.live = false; };
  }, [path, run]);
  const reload = useCallback(() => { if (path) void run(path, true, { live: true }); }, [path, run]);
  return { data, pending, error, busy, at, reload };
}

/** Refresh, with the time the shown data was read. */
export function RefreshBar({ at, busy, onRefresh, generatedAt }: { at: string | null; busy: boolean; onRefresh: () => void; generatedAt?: string }) {
  return (
    <div className="flex items-center gap-3 text-[12px] text-muted">
      {(generatedAt || at) && <span>As of {fmtDate(generatedAt ?? at ?? undefined)}</span>}
      <Button size="sm" variant="ghost" onClick={onRefresh} disabled={busy} icon={<RefreshCw className={cx('size-3.5', busy && 'animate-spin')} />}>Refresh</Button>
    </div>
  );
}

/** While a read runs: how far it got. */
export function Reading({ what, pending }: { what: string; pending: InvestigatePending | null }) {
  const share = pending && pending.total > 0 ? Math.min(100, (pending.done / pending.total) * 100) : null;
  return (
    <Loading label={`Reading ${what} from Cloudflare`} className="space-y-4">
      <div className="text-xs text-muted">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span>Reading {what} from Cloudflare…</span>
          {pending && pending.total > 0 && <span className="tabular-nums text-faint">{pending.done} of {pending.total} queries</span>}
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-raised">
          <div className={cx('h-full rounded-full bg-signal transition-all', share === null && 'progress-live w-1/3')} style={share !== null ? { width: `${Math.max(4, share)}%` } : undefined} />
        </div>
        {pending?.note && <div className="mt-2 text-warn">{pending.note}</div>}
      </div>
      <SkeletonTable rows={4} cols={4} />
    </Loading>
  );
}

export interface PickedZone { id: string; name: string; accountId: string; accountName: string; plan: string }

/** A zone search box: matches come from the server (a page of 20), chosen with the mouse or the keyboard. `accountId`: that account's zones only. */
export function ZonePicker({ label, value, onChange, hint, accountId, disabled, placeholder }: { label: string; value: PickedZone | null; onChange: (z: PickedZone | null) => void; hint?: string; accountId?: string; disabled?: boolean; placeholder?: string }) {
  const id = useId();
  const [typed, setTyped] = useState<string | null>(null);
  /** What the box shows: what is being typed, else the chosen zone. */
  const q = typed ?? value?.name ?? '';
  const [hits, setHits] = useState<PickedZone[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    let live = true;
    // Asked when the user stops typing for a moment, not on every key.
    const t = setTimeout(() => {
      api<{ zones: PickedZone[]; total: number }>(`/api/investigate/zones?limit=20&q=${encodeURIComponent(term)}${accountId ? `&account=${encodeURIComponent(accountId)}` : ''}`)
        .then((r) => { if (live) { setHits(r.zones); setTotal(r.total); setActive(0); } }).catch(() => { if (live) setHits([]); });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q, open, accountId]);
  const pick = (z: PickedZone) => { onChange(z); setTyped(null); setOpen(false); };
  return (
    <div className="relative space-y-1.5">
      <label htmlFor={id} className="flex items-center gap-2 text-[13px] font-medium text-ink-2">{label}</label>
      <input id={id} className="input" role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" autoComplete="off"
        aria-activedescendant={open && hits[active] ? `${id}-${hits[active].id}` : undefined}
        placeholder={placeholder ?? 'Type a zone name…'} value={q} disabled={disabled}
        onChange={(e) => { setTyped(e.target.value); setOpen(true); if (!e.target.value) onChange(null); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(hits.length - 1, a + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === 'Enter' && open && hits[active]) { e.preventDefault(); pick(hits[active]); }
          else if (e.key === 'Escape') setOpen(false);
        }} />
      {hint && <p className="text-xs text-muted">{hint}</p>}
      {open && hits.length > 0 && (
        <ul id={`${id}-list`} role="listbox" className="panel absolute z-20 mt-1 max-h-72 w-full overflow-y-auto py-1 shadow-lg">
          {hits.map((z, i) => (
            <li key={z.id} id={`${id}-${z.id}`} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(z); }}
              className={cx('flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 text-[13px]', i === active ? 'bg-raised text-ink' : 'text-ink-2')}>
              <span className="truncate">{z.name}</span><span className="shrink-0 truncate text-[11px] text-faint">{z.accountName}</span>
            </li>
          ))}
          {total > hits.length && <li className="px-3 py-1.5 text-[11px] text-faint">{total - hits.length} more — keep typing</li>}
        </ul>
      )}
    </div>
  );
}

export interface PickedAccount { id: string; name: string; zones: number }

/** The accounts (66 or so: one list, loaded once). */
export function useAccounts() {
  const [accounts, setAccounts] = useState<PickedAccount[] | null>(null);
  useEffect(() => {
    let live = true;
    api<{ accounts?: PickedAccount[] }>('/api/investigate/zones?limit=1&accounts=1').then((r) => { if (live) setAccounts(r.accounts ?? []); }).catch(() => { if (live) setAccounts([]); });
    return () => { live = false; };
  }, []);
  return accounts;
}

/** Copy-able code. */
export function Code({ children, className }: { children: string; className?: string }) {
  return <pre className={cx('overflow-x-auto rounded-lg border border-line bg-sunken/60 px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-all text-ink-2', className)}>{children}</pre>;
}

export { whole } from '@/lib/num';
