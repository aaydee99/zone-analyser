'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import { CHART_COLORS, ChartTable, LineChart, type ChartMarker, type LineSeries } from '@/components/line-chart';
import { Alert, Badge, Button, Card, Loading, SectionHeader, SkeletonChart, Stat, cx } from '@/components/ui';
import {
  DROP_RATIO, FINE_SCORE, FLAG_LABEL, HIGH_ORIGIN, MIN_REQUESTS, ORIGIN_SHARE_JUMP, ORIGIN_WINDOW_JUMP, PEAK_FACTOR, QUIET_FACTOR, SCORE, SPIKE_RATIO,
  type Flag, type FlagKind, type WindowId, type WindowSummary,
} from '@/lib/traffic-anomaly';
import type { PatternPending, PatternReport } from '@/lib/traffic-pattern';
import { bytes, num } from './format';
import { useOpenDetail, type Target } from './zone-detail';

// Unusual traffic for the account or zone the page shows: the last 30 days, 7 days, 24 hours and
// 6 hours, each judged against the scope's own hour-of-day pattern (src/lib/traffic-anomaly.ts).
// Times are US Eastern. Status codes play no part.

const TZ = 'America/New_York';
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtHour = (h: number) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);
/** [9, 10, 11, 14] → "9 AM–12 PM, 2–3 PM" (each range ends where its last hour ends). */
function hourRanges(hs: number[]) {
  const out: string[] = [];
  const s = [...hs].sort((a, b) => a - b);
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(`${fmtHour(s[i])}–${fmtHour((s[j] + 1) % 24)}`);
    i = j;
  }
  return out.join(', ') || 'none';
}
const pctOf = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const TONE: Record<FlagKind, 'bad' | 'warn' | 'info'> = { spike: 'bad', off_peak: 'bad', drop: 'warn', origin_spike: 'bad', origin_share: 'warn' };
const BADGE: Record<'bad' | 'warn' | 'info', 'bad' | 'warn' | 'info'> = { bad: 'bad', warn: 'warn', info: 'info' };

function when(f: Flag, step: WindowSummary['step']) {
  const one = Date.parse(f.end) - Date.parse(f.start) <= (step === 'hour' ? 3_600_000 : 300_000);
  return one ? fullFmt.format(new Date(f.start)) : `${fullFmt.format(new Date(f.start))} – ${hourFmt.format(new Date(f.end))}`;
}

export function TrafficPatterns({ account, zone, target }: { account: string; zone?: string; target?: Target }) {
  const [kept, setData] = useState<PatternReport | null>(null);
  const [pending, setPending] = useState<PatternPending | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [win, setWin] = useState<WindowId>('24h');
  const seq = useRef(0);
  const open = useOpenDetail();
  // Leaving the page ends a read's polling loop.
  useEffect(() => { const r = seq; return () => { r.current++; }; }, []);

  const load = useCallback(async (fresh = false) => {
    const me = ++seq.current;
    setBusy(true); setError(''); setPending(null);
    const q = `account=${encodeURIComponent(account)}${zone ? `&zone=${encodeURIComponent(zone)}` : ''}`;
    try {
      for (let first = true; ; first = false) {
        const r = await api<PatternReport | PatternPending>(`/api/traffic/patterns?${q}${fresh && first ? '&fresh=1' : ''}`);
        if (me !== seq.current) return;
        if (!('pending' in r)) { setData(r); break; }
        setPending(r);
        await new Promise((res) => setTimeout(res, 3_000));
        if (me !== seq.current) return;
      }
    } catch (e) {
      if (me === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (me === seq.current) { setBusy(false); setPending(null); }
    }
  }, [account, zone]);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  // Shown only for the account or zone chosen now (an answer for the previous choice is not).
  const data = kept && kept.scope.accountId === account && (kept.scope.zoneId ?? '') === (zone ?? '') ? kept : null;
  const w = data?.windows.find((x) => x.id === win) ?? null;
  const scopeName = zone ? 'this zone' : 'this account';
  return (
    <Card>
      <SectionHeader title="Unusual traffic"
        description={`Spikes, drops, busy quiet hours and origin load in the last 30 days, 7 days, 24 hours and 6 hours, each judged against ${scopeName}'s own pattern for that hour of the day. Times in US Eastern. Status codes are not considered: every request counts.`}
        aside={<Button variant="ghost" size="sm" onClick={() => void load(true)} disabled={busy} icon={<RefreshCw className={cx('size-3.5', busy && 'animate-spin')} />}>Refresh</Button>} />
      <div className="space-y-5 p-5">
        {error && <Alert tone="bad" title="Traffic patterns could not be read">{error}</Alert>}
        {!data && busy && (
          <Loading label="Reading 30 days of traffic">
            <p className="mb-3 text-xs text-muted">Reading 30 days hour by hour and the last 24 hours in 5-minute steps…{pending && pending.total > 0 ? ` ${pending.done} of ${pending.total} parts` : ''}</p>
            <SkeletonChart bars={40} height="h-48" />
          </Loading>
        )}
        {data && (
          <>
            <div role="tablist" aria-label="Time window" className="flex flex-wrap gap-2">
              {data.windows.map((x) => {
                const bad = x.flags.length;
                return (
                  <button key={x.id} type="button" role="tab" aria-selected={win === x.id} onClick={() => setWin(x.id)}
                    className={cx('inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] transition-colors', win === x.id ? 'border-signal bg-raised text-ink' : 'border-line text-ink-2 hover:border-line-strong hover:text-ink')}>
                    {x.label}
                    {x.available ? <Badge tone={bad ? 'bad' : 'ok'}>{bad ? `${bad} flagged` : 'normal'}</Badge> : <Badge tone="neutral">not read</Badge>}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted">
              Usual pattern (last {Math.round(data.coverage.hourlyPoints / 24)} days): busiest {hourRanges(data.profile.peakHours)} ET · quiet {hourRanges(data.profile.quietHours)} ET · a typical peak hour carries {num(data.profile.peakLevel)} requests.
            </p>
            {w && <WindowView w={w} minChange={data.minChange} onOpen={target ? (f) => {
              const at = new Date(f.at);
              open({ t: { ...target, month: f.at.slice(0, 7) }, filter: { day: f.at.slice(0, 10), hour: at.getUTCHours() }, label: `${FLAG_LABEL[f.kind]} · ${fullFmt.format(at)} ET` });
            } : undefined} />}
            {data.coverage.notes.length > 0 && <Alert tone="info" title="Not everything could be read">{data.coverage.notes.join(' ')}</Alert>}
            <details className="text-xs">
              <summary className="cursor-pointer text-muted hover:text-ink">How this is judged</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
                <li>The pattern: for each hour of the day (US Eastern), weekdays and weekends apart, the median of that hour on the other days of the last 30 — one past spike does not change what counts as usual.</li>
                <li>Peak hours carry at least {PEAK_FACTOR}× a typical hour; quiet hours at most {QUIET_FACTOR}×.</li>
                <li>A point is flagged only when its robust score (distance from usual ÷ spread, from the median absolute deviation) is at least {SCORE} ({FINE_SCORE} for 5-minute points, judged as an hourly rate), it is at least {SPIKE_RATIO}× usual (drops: at most {DROP_RATIO}×), and the change is at least {num(data.minChange)} requests an hour (the larger of {MIN_REQUESTS} and 5% of a typical peak hour).</li>
                <li>Busy at a quiet hour: a quiet hour at three-quarters of a usual peak hour or more. Drops at quiet hours are not flagged.</li>
                <li>Origin: requests not served from cache. An origin spike uses the same rules; the origin share is flagged {Math.round(ORIGIN_SHARE_JUMP * 100)} points or more above its usual share. A window&apos;s origin load is unusual {Math.round(ORIGIN_WINDOW_JUMP * 100)} points above usual, and high at {Math.round(HIGH_ORIGIN * 100)}% or more of requests.</li>
                <li>Read from Cloudflare&apos;s httpRequestsOverviewAdaptiveGroups ({data.queries} queries, {data.coverage.hourlyPoints} hours and {data.coverage.finePoints} five-minute points); every request counts whatever its status code.</li>
              </ul>
            </details>
            <p className="text-[11px] text-faint">Read {fmtDate(data.generatedAt)}{data.cachedIn ? ' (kept for 10 minutes — Refresh reads again)' : ''}</p>
          </>
        )}
      </div>
    </Card>
  );
}

function WindowView({ w, minChange, onOpen }: { w: WindowSummary; minChange: number; onOpen?: (f: Flag) => void }) {
  const fine = w.step === '5min';
  const fmtX = (t: string) => (w.id === '30d' || w.id === '7d' ? dayFmt.format(new Date(t)) : hourFmt.format(new Date(t)));
  const per = fine ? 'per 5 minutes' : 'per hour';
  const req = useMemo((): LineSeries[] => [
    { key: 'requests', label: `Requests ${per}`, color: CHART_COLORS.blue, values: w.points.map((p) => p.requests) },
    { key: 'usual', label: 'Usual for this time', color: CHART_COLORS.usual, values: w.points.map((p) => (p.expected === null ? null : Math.round(p.expected))), dashed: true },
    { key: 'origin', label: 'Served by origin', color: CHART_COLORS.orange, values: w.points.map((p) => p.origin) },
  ], [w, per]);
  const bw = useMemo((): LineSeries[] => [
    { key: 'bytes', label: `Bandwidth ${per}`, color: CHART_COLORS.blue, values: w.points.map((p) => p.bytes) },
    { key: 'originBytes', label: 'Served by origin', color: CHART_COLORS.orange, values: w.points.map((p) => p.originBytes) },
  ], [w, per]);
  const markers = useMemo((): ChartMarker[] => w.points.flatMap((p, i) => (p.flags.length ? [{ index: i, label: p.flags.map((k) => FLAG_LABEL[k]).join(', '), tone: p.flags.some((k) => TONE[k] === 'bad') ? 'bad' as const : 'warn' as const }] : [])), [w]);
  const peak = w.points.reduce<(typeof w.points)[number] | null>((m, p) => (!m || p.requests > m.requests ? p : m), null);
  if (!w.available) return <Alert tone="info" title={`${w.label}: not read`}>{w.note}</Alert>;
  const change = w.expectedTotal ? (w.total - w.expectedTotal) / w.expectedTotal : null;
  const pickAt = (i: number) => { const f = w.flags.find((x) => Date.parse(x.start) <= Date.parse(w.points[i].t) && Date.parse(w.points[i].t) < Date.parse(x.end)); if (f && onOpen) onOpen(f); };
  return (
    <div className="space-y-5">
      {w.note && <Alert tone="info">{w.note}</Alert>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Requests" value={num(w.total)} sub={change === null ? 'Too little history to compare' : `${change >= 0 ? '+' : ''}${Math.round(change * 100)}% vs usual for these hours`} />
        <Stat label="Served by origin" value={pctOf(w.originShare)} sub={`Usual ${pctOf(w.expectedOriginShare)} for these hours`}
          tone={w.originStatus === 'unusual' || w.originStatus === 'high' ? 'warn' : undefined} />
        <Stat label="Flagged" value={w.flags.length} sub={w.flags.length ? [...new Set(w.flags.map((f) => FLAG_LABEL[f.kind]))].join(', ') : 'Nothing unusual'} tone={w.flags.length ? 'bad' : 'ok'} />
        <Stat label={`Busiest ${fine ? '5 minutes' : 'hour'}`} value={peak ? num(peak.requests) : '—'} sub={peak ? `${fullFmt.format(new Date(peak.t))} ET` : ''} />
      </div>
      {w.originStatus === 'unusual' && <Alert tone="warn" title="The origin served much more than usual">{pctOf(w.originShare)} of requests in this window reached the origin, against a usual {pctOf(w.expectedOriginShare)} for these hours. The cache is serving less than it normally does: look for a purge, a cache rule change, or traffic to uncacheable paths.</Alert>}
      {w.originStatus === 'high' && <Alert tone="info" title="Most requests reach the origin">{pctOf(w.originShare)} of requests in this window were not served from cache. That is usual for {pctOf(w.expectedOriginShare)} here, so it is not unusual, but the origin carries most of the load — cache rules for static paths would take it off the origin.</Alert>}
      <div>
        <div className="mb-1 text-xs font-medium text-ink-2">Requests {per} · {w.label.toLowerCase()} (ET)</div>
        <LineChart x={w.points.map((p) => p.t)} series={req} markers={markers} height={240} label={`Requests ${per}, ${w.label.toLowerCase()}, with the usual level and requests served by the origin`}
          formatX={fmtX} formatTip={(t) => `${fullFmt.format(new Date(t))} ET`} formatY={(n) => num(n)} onPick={onOpen ? pickAt : undefined} pickHint={onOpen ? 'Click a flagged point for its traffic' : undefined} />
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-ink-2">Bandwidth {per}</div>
        <LineChart x={w.points.map((p) => p.t)} series={bw} height={170} label={`Bandwidth ${per}, ${w.label.toLowerCase()}`}
          formatX={fmtX} formatTip={(t) => `${fullFmt.format(new Date(t))} ET`} formatY={(n) => bytes(n)} />
      </div>
      <div>
        <h3 className="mb-2 text-[13px] font-medium text-ink">{w.flags.length ? `What was flagged (${w.flags.length})` : 'Nothing unusual in this window'}</h3>
        {!w.flags.length ? <p className="text-xs text-muted">Every {fine ? '5-minute point' : 'hour'} was within its usual range for that hour of the day (changes smaller than {num(minChange)} requests an hour are never flagged).</p> : (
          <ul className="divide-y divide-line/70 rounded-md border border-line">
            {w.flags.map((f, i) => (
              <li key={`${f.kind}:${f.start}:${i}`} className="flex min-w-0 flex-col gap-1 px-4 py-3 text-[12.5px] sm:flex-row sm:items-start sm:gap-4">
                <div className="flex shrink-0 items-center gap-2 sm:w-56">
                  <Badge tone={BADGE[TONE[f.kind]]}>{FLAG_LABEL[f.kind]}</Badge>
                  {f.hourClass !== 'normal' && <span className="text-[11px] text-faint">{f.hourClass === 'peak' ? 'peak hour' : 'quiet hour'}</span>}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink">{when(f, w.step)} ET</div>
                  <p className="mt-0.5 break-words text-ink-2">{f.explain}</p>
                  <p className="mt-0.5 text-[11px] text-faint">Score {f.score.toFixed(1)} · {num(f.total)} requests in the event, usual {num(Math.round(f.expectedTotal))}</p>
                </div>
                {onOpen && <Button size="sm" variant="ghost" className="shrink-0 self-start" onClick={() => onOpen(f)}>See the traffic</Button>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ChartTable title={`Numbers (${w.points.length} ${fine ? 'five-minute points' : 'hours'})`} head={['Time (ET)', 'Requests', 'Usual', 'Served by origin', 'Bandwidth', 'Flag']}
        rows={w.points.map((p) => [fullFmt.format(new Date(p.t)), num(p.requests), p.expected === null ? '—' : num(p.expected), num(p.origin), bytes(p.bytes), p.flags.map((k) => FLAG_LABEL[k]).join(', ')])} />
    </div>
  );
}
