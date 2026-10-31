'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Clock, RefreshCw, Star } from 'lucide-react';
import { api, relTime } from '@/lib/client';
import { Card, Skeleton, cx } from './ui';

// The signed-in user's starred zones and the zones they opened last (their own only), with links
// to each zone in the zone explorer. Read once when shown; ↻ reads again (no polling).

export interface QuickZone { zoneId: string; zoneName: string; accountName: string; at: string }

export const zoneHref = (id: string) => `/console/zone-explorer?zone=${encodeURIComponent(id)}`;

function ZoneLinks({ list, empty }: { list: QuickZone[]; empty: string }) {
  if (!list.length) return <p className="px-4 py-2 text-[12.5px] text-muted">{empty}</p>;
  return (
    <ul>
      {list.map((z) => (
        <li key={z.zoneId}>
          <Link href={zoneHref(z.zoneId)} className="flex items-center gap-2 px-4 py-1.5 text-[13px] hover:bg-raised/60">
            <span className="min-w-0 flex-1 truncate text-ink">{z.zoneName || z.zoneId}</span>
            {z.accountName && <span className="max-w-[45%] shrink-0 truncate text-[11px] text-faint">{z.accountName}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Favourites and recent zones. `limit` caps each list (the header uses a few; the overview more).
 * A missing migration or a failed read shows as one quiet line, never an error page.
 */
export function QuickZones({ limit = 8, className }: { limit?: number; className?: string }) {
  const [data, setData] = useState<{ favourites: QuickZone[]; recents: QuickZone[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const load = useCallback(async () => {
    setBusy(true);
    try { setData(await api<{ favourites: QuickZone[]; recents: QuickZone[] }>('/api/me/zones')); setError(''); setAt(Date.now()); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <Card className={cx('overflow-hidden', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="text-[14px] font-semibold">Your zones</h2>
        <span className="flex items-center gap-2 text-[11px] text-faint">
          {at && <span>as of {relTime(at)}</span>}
          <button type="button" className="rounded p-1 text-muted hover:bg-raised hover:text-ink disabled:opacity-40" onClick={load} disabled={busy} aria-label="Refresh your zones" title="Refresh">
            <RefreshCw className={cx('size-3.5', busy && 'animate-spin')} />
          </button>
        </span>
      </div>
      {error ? <p className="px-4 py-3 text-[12.5px] text-muted">{error}</p> : !data ? (
        <div className="space-y-2 px-4 py-3">{[70, 55, 80].map((w) => <Skeleton key={w} className="h-3" style={{ width: `${w}%` }} />)}</div>
      ) : (
        <div className="grid divide-line sm:grid-cols-2 sm:divide-x">
          <section className="py-2">
            <h3 className="flex items-center gap-1.5 px-4 pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase"><Star className="size-3" aria-hidden /> Favourites</h3>
            <ZoneLinks list={data.favourites.slice(0, limit)} empty="Star a zone in the zone explorer to keep it here." />
          </section>
          <section className="py-2">
            <h3 className="flex items-center gap-1.5 px-4 pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase"><Clock className="size-3" aria-hidden /> Recent</h3>
            <ZoneLinks list={data.recents.slice(0, limit)} empty="Zones you open appear here." />
          </section>
        </div>
      )}
    </Card>
  );
}

/** A star that adds the zone to (or removes it from) the signed-in user's favourites. */
export function FavouriteStar({ zoneId, zoneName }: { zoneId: string; zoneName: string }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setOn(null); setError('');
    api<{ on: boolean }>(`/api/me/zones/favourite?zoneId=${encodeURIComponent(zoneId)}`).then((r) => { if (live) setOn(r.on); }).catch(() => { if (live) setOn(false); });
    return () => { live = false; };
  }, [zoneId]);
  const toggle = async () => {
    setBusy(true);
    try { setOn((await api<{ on: boolean }>('/api/me/zones/favourite', { method: 'PUT', json: { zoneId, on: !on } })).on); setError(''); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <button type="button" onClick={toggle} disabled={on === null || busy} aria-pressed={!!on}
      aria-label={on ? `Remove ${zoneName} from your favourites` : `Add ${zoneName} to your favourites`} title={error || (on ? 'In your favourites' : 'Add to your favourites')}
      className={cx('inline-flex h-8 items-center justify-center rounded-[10px] border px-2 transition-colors disabled:opacity-50', on ? 'border-signal/40 bg-signal/10 text-signal' : 'border-line-strong bg-raised text-muted hover:text-ink', error && 'border-bad/40')}>
      <Star className={cx('size-4', on && 'fill-current')} />
    </button>
  );
}
