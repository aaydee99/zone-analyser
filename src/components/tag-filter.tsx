'use client';

import { compactNum } from '@/lib/num';
import { useCallback, useEffect, useId, useState } from 'react';
import { Tag, X } from 'lucide-react';
import { api } from '@/lib/client';
import { normalizeTag, type ZoneMetaFilter } from '@/lib/zone-meta-types';
import { cx } from './ui';

// A zone tag and owner filter any page can drop in (the zone explorer, monitoring findings, the tags
// page), and the small tag chips lists show. The page passes the filter to its API (?tags=&owner=),
// which resolves it in the database. The known tags load once per tab, when the filter is first used.

export interface TagCount { tag: string; count: number }
export interface OwnerCount { owner: string; count: number }

let known: Promise<{ tags: TagCount[]; owners: OwnerCount[] }> | null = null;

/** The tags and owners in use (shared by every filter on the page); `fresh` reads them again. */
export function knownTags(fresh = false) {
  if (fresh || !known) {
    known = api<{ tags: TagCount[]; owners: OwnerCount[] }>('/api/zones/tags').catch((e) => { known = null; throw e; });
  }
  return known;
}

export function useKnownTags(enabled = true) {
  const [data, setData] = useState<{ tags: TagCount[]; owners: OwnerCount[] } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback((fresh = false) => knownTags(fresh).then((d) => { setData(d); setError(''); }).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { if (enabled) void load(); }, [enabled, load]);
  return { data, error, reload: () => load(true) };
}

/** Tags as small chips; `onPick` makes each one a button (e.g. filter by it). */
export function TagChips({ tags, owner, onPick, max = 6, className }: { tags: string[]; owner?: string; onPick?: (tag: string) => void; max?: number; className?: string }) {
  if (!tags.length && !owner) return null;
  const shown = tags.slice(0, max);
  const chip = 'inline-flex max-w-[160px] items-center rounded-md border border-line bg-raised/60 px-1.5 py-px font-mono text-[10.5px] leading-4 text-ink-2';
  return (
    <span className={cx('flex flex-wrap items-center gap-1', className)}>
      {shown.map((t) => onPick
        ? <button key={t} type="button" className={cx(chip, 'hover:border-signal/50 hover:text-ink')} onClick={(e) => { e.stopPropagation(); onPick(t); }} title={`Show zones tagged ${t}`}><span className="truncate">{t}</span></button>
        : <span key={t} className={chip} title={t}><span className="truncate">{t}</span></span>)}
      {tags.length > max && <span className="text-[10.5px] text-faint">+{tags.length - max}</span>}
      {owner && <span className="truncate text-[11px] text-muted" title={`Owner: ${owner}`}>· {owner}</span>}
    </span>
  );
}

/**
 * Zones with all of the chosen tags, and (optionally) of one owner. Changes go to `onChange` at once;
 * the page reloads its list from the server with them.
 */
export function TagFilter({ value, onChange, showOwner = true, className }: { value: ZoneMetaFilter; onChange: (f: ZoneMetaFilter) => void; showOwner?: boolean; className?: string }) {
  const [used, setUsed] = useState(!!value.tags?.length || !!value.owner);
  const { data, error } = useKnownTags(used);
  const [text, setText] = useState('');
  const listId = useId();
  const inputId = useId();
  const ownerId = useId();
  const tags = value.tags ?? [];
  const add = (raw: string) => {
    const t = normalizeTag(raw);
    setText('');
    if (!t || tags.includes(t) || tags.length >= 10) return;
    onChange({ ...value, tags: [...tags, t].sort() });
  };
  const remove = (t: string) => onChange({ ...value, tags: tags.filter((x) => x !== t) });
  return (
    <div className={cx('flex flex-wrap items-center gap-2', className)}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-[9px] border border-line bg-sunken/60 px-2 py-1">
        <Tag className="size-3.5 shrink-0 text-faint" aria-hidden />
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-0.5 rounded-md border border-signal/40 bg-signal/10 py-px pr-0.5 pl-1.5 font-mono text-[11px] text-ink">
            {t}
            <button type="button" className="rounded p-0.5 text-muted hover:text-ink" onClick={() => remove(t)} aria-label={`Remove the tag filter ${t}`}><X className="size-3" /></button>
          </span>
        ))}
        <label htmlFor={inputId} className="sr-only">Filter by zone tag</label>
        <input id={inputId} list={listId} className="min-w-[90px] flex-1 bg-transparent py-0.5 text-[12.5px] outline-none placeholder:text-faint"
          placeholder={tags.length ? 'Add a tag…' : 'Filter by tag…'} value={text} onFocus={() => setUsed(true)}
          onChange={(e) => {
            const v = e.target.value;
            // Picking from the list fills in a whole known tag: take it at once.
            if (data?.tags.some((x) => x.tag === v)) add(v); else setText(v);
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',') && text.trim()) { e.preventDefault(); add(text); }
            if (e.key === 'Backspace' && !text && tags.length) remove(tags[tags.length - 1]);
          }} />
        <datalist id={listId}>
          {(data?.tags ?? []).filter((x) => !tags.includes(x.tag)).slice(0, 300).map((x) => <option key={x.tag} value={x.tag}>{`${compactNum(x.count)} zone${x.count === 1 ? '' : 's'}`}</option>)}
        </datalist>
      </div>
      {showOwner && (
        <>
          <label htmlFor={ownerId} className="sr-only">Filter by owner</label>
          <select id={ownerId} className="input !h-8 !w-auto max-w-[200px] !py-0 !text-[12.5px]" value={value.owner ?? ''} onFocus={() => setUsed(true)}
            onChange={(e) => onChange({ ...value, owner: e.target.value })}>
            <option value="">Any owner</option>
            {value.owner && !data?.owners.some((o) => o.owner.toLowerCase() === value.owner!.toLowerCase()) && <option value={value.owner}>{value.owner}</option>}
            {(data?.owners ?? []).map((o) => <option key={o.owner} value={o.owner}>{o.owner} ({o.count})</option>)}
          </select>
        </>
      )}
      {(tags.length > 0 || value.owner) && (
        <button type="button" className="text-[12px] text-muted hover:text-ink" onClick={() => onChange({ ...value, tags: [], owner: '' })}>Clear</button>
      )}
      {error && <span className="text-[11.5px] text-warn" role="status">{error}</span>}
    </div>
  );
}
