// Unusual traffic: spikes, drops, busy "quiet" hours and origin load, judged against the scope's own
// pattern. Pure — the reader (traffic-pattern.ts) supplies the points, the page and the tests call this.
//
// The pattern: for every hour of the day in US Eastern time, split into weekdays and weekends, the
// median and the median absolute deviation (MAD) of that hour over the last 30 days (each point is
// compared with the *other* days, never with itself). Medians, not means, so one past spike does not
// raise what counts as usual. Status codes play no part: every request counts the same.
//
// A point is flagged when all three hold (so small zones and normal busy hours are not flagged):
//   1. robust score (value − usual) ÷ spread ≥ SCORE (spread = 1.4826 × MAD, at least 15% of usual
//      and half the minimum change), 5-minute points need FINE_SCORE;
//   2. value ≥ SPIKE_RATIO × usual (drops: ≤ DROP_RATIO × usual);
//   3. the change is at least the minimum: MIN_REQUESTS an hour, or 5% of a typical peak hour.
// Kinds:
//   spike — above the pattern for that hour;
//   off_peak — at a usually quiet hour (≤ QUIET_FACTOR × a typical hour), as busy as a usual peak hour;
//   drop — far below the pattern at a normal or peak hour (drops at quiet hours are noise);
//   origin_spike — requests that reached the origin (not served from cache) above their pattern;
//   origin_share — the share served by the origin ORIGIN_SHARE_JUMP or more above its usual share.
// Each window (30 days, 7 days, 24 hours, 6 hours) is judged on its own points; neighbouring flagged
// points of one kind are merged into one event.

export const TZ = 'America/New_York';
export const SCORE = 4;
export const FINE_SCORE = 5;
export const SPIKE_RATIO = 1.5;
export const DROP_RATIO = 0.5;
export const MIN_REQUESTS = 50;
export const MIN_BYTES = 1_000_000;
export const ORIGIN_SHARE_JUMP = 0.2;
/** A window's share served by the origin this far above usual is "unusual"; at or above HIGH_ORIGIN it is "high" whatever is usual. */
export const ORIGIN_WINDOW_JUMP = 0.15;
export const HIGH_ORIGIN = 0.8;
/** Comparable past values needed before a point is judged. */
export const MIN_HISTORY = 3;

export interface Point { t: string; requests: number; cached: number; bytes: number; cachedBytes: number }
export type WindowId = '30d' | '7d' | '24h' | '6h';
export type FlagKind = 'spike' | 'off_peak' | 'drop' | 'origin_spike' | 'origin_share';
export type HourClass = 'peak' | 'off_peak' | 'normal';
export const FLAG_LABEL: Record<FlagKind, string> = {
  spike: 'Spike', off_peak: 'Busy at a quiet hour', drop: 'Drop', origin_spike: 'Origin spike', origin_share: 'More served by origin',
};

export interface Flag {
  kind: FlagKind;
  window: WindowId;
  start: string;
  /** The end of the last point (exclusive). */
  end: string;
  /** The worst point of the event. */
  at: string;
  /** Requests an hour at the worst point (origin requests for origin_spike; share for origin_share), and what is usual then. */
  value: number;
  expected: number;
  ratio: number;
  score: number;
  hourClass: HourClass;
  /** Requests in the event and what is usual for those points. */
  total: number;
  expectedTotal: number;
  explain: string;
}

export interface SeriesPoint {
  t: string;
  requests: number;
  origin: number;
  bytes: number;
  originBytes: number;
  /** Usual for this hour of the day (rate per point), or null when there is too little history. */
  expected: number | null;
  expectedOrigin: number | null;
  flags: FlagKind[];
}

export interface WindowSummary {
  id: WindowId;
  label: string;
  /** hour: one point an hour; 5min: one point every five minutes. */
  step: 'hour' | '5min';
  available: boolean;
  note?: string;
  since: string | null;
  until: string | null;
  points: SeriesPoint[];
  total: number;
  expectedTotal: number | null;
  originShare: number | null;
  expectedOriginShare: number | null;
  /** normal, unusual (well above its usual share), or high (most requests reach the origin). */
  originStatus: 'normal' | 'unusual' | 'high' | 'unknown';
  flags: Flag[];
}

export interface Profile {
  /** Usual requests an hour, per hour of the day (US Eastern), all days. */
  hours: { hour: number; median: number; cls: HourClass }[];
  peakHours: number[];
  quietHours: number[];
  /** A usual peak hour's requests. */
  peakLevel: number;
  days: number;
}

export interface PatternAnalysis { tz: string; profile: Profile; windows: WindowSummary[]; minChange: number }

// ── Time ────────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const STEP_MS = { hour: HOUR_MS, '5min': 300_000 } as const;
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
/** The point's hour, weekday or weekend, and day — in US Eastern time. */
export function eastern(iso: string) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, weekend: p.weekday === 'Sat' || p.weekday === 'Sun', day: `${p.year}-${p.month}-${p.day}` };
}

// ── Statistics ──────────────────────────────────────────────────────────────

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mad = (xs: number[], m: number) => median(xs.map((x) => Math.abs(x - m)));

type Metric = 'requests' | 'origin' | 'bytes' | 'originBytes';
const metricOf = (p: Point, m: Metric) => (m === 'requests' ? p.requests : m === 'origin' ? Math.max(0, p.requests - p.cached) : m === 'bytes' ? p.bytes : Math.max(0, p.bytes - p.cachedBytes));

interface Baseline { median: number; mad: number; n: number }
/** Past values of each hour of the day (weekday / weekend split, and all days), with the day each came from. */
class History {
  private by = new Map<string, { day: string; v: Record<Metric, number>; share: number | null }[]>();
  constructor(points: Point[]) {
    for (const p of points) {
      const e = eastern(p.t);
      const row = { day: e.day, v: { requests: p.requests, origin: metricOf(p, 'origin'), bytes: p.bytes, originBytes: metricOf(p, 'originBytes') }, share: p.requests ? metricOf(p, 'origin') / p.requests : null };
      for (const k of [`${e.weekend ? 'we' : 'wd'}:${e.hour}`, `all:${e.hour}`]) { const l = this.by.get(k) ?? []; l.push(row); this.by.set(k, l); }
    }
  }
  /** The usual value for this hour (same kind of day first, else all days), leaving out the day the point is on. */
  baseline(t: string, m: Metric): Baseline | null {
    const e = eastern(t);
    for (const k of [`${e.weekend ? 'we' : 'wd'}:${e.hour}`, `all:${e.hour}`]) {
      const xs = (this.by.get(k) ?? []).filter((r) => r.day !== e.day).map((r) => r.v[m]);
      if (xs.length >= MIN_HISTORY) { const md = median(xs); return { median: md, mad: mad(xs, md), n: xs.length }; }
    }
    return null;
  }
  shareBaseline(t: string): number | null {
    const e = eastern(t);
    for (const k of [`${e.weekend ? 'we' : 'wd'}:${e.hour}`, `all:${e.hour}`]) {
      const xs = (this.by.get(k) ?? []).filter((r) => r.day !== e.day && r.share !== null).map((r) => r.share!);
      if (xs.length >= MIN_HISTORY) return median(xs);
    }
    return null;
  }
}

/** Peak hours carry at least PEAK_FACTOR × a typical hour; quiet hours at most QUIET_FACTOR × it. */
export const PEAK_FACTOR = 1.3, QUIET_FACTOR = 0.6;
/** The day's usual shape: each hour's median, peak hours and quiet hours (against a typical hour). */
export function profileOf(hourly: Point[]): Profile {
  const per = Array.from({ length: 24 }, () => [] as number[]);
  const days = new Set<string>();
  for (const p of hourly) { const e = eastern(p.t); per[e.hour].push(p.requests); days.add(e.day); }
  const medians = per.map((xs) => median(xs));
  // Against a typical hour (the median of the 24): a flat day has neither peak nor quiet hours.
  const mid = median(medians);
  const hours = medians.map((m, hour) => ({ hour, median: m, cls: (m >= PEAK_FACTOR * mid && m > 0 ? 'peak' : m <= QUIET_FACTOR * mid ? 'off_peak' : 'normal') as HourClass }));
  const peakHours = hours.filter((h) => h.cls === 'peak').map((h) => h.hour);
  return { hours, peakHours, quietHours: hours.filter((h) => h.cls === 'off_peak').map((h) => h.hour), peakLevel: median(peakHours.map((h) => medians[h])) || Math.max(0, ...medians), days: days.size };
}

// ── Judging points ──────────────────────────────────────────────────────────

interface Judged { kind: FlagKind; value: number; expected: number; ratio: number; score: number }

/** What is unusual about one point (rate per hour), or nothing. `scale` turns a 5-minute value into an hourly rate. */
function judge(p: Point, h: History, prof: Profile, minChange: number, scale: number, fine: boolean): { judged: Judged[]; expected: number | null; expectedOrigin: number | null; cls: HourClass } {
  const need = fine ? FINE_SCORE : SCORE;
  const cls = prof.hours[eastern(p.t).hour]?.cls ?? 'normal';
  const out: Judged[] = [];
  const req = p.requests * scale, org = metricOf(p, 'origin') * scale;
  const b = h.baseline(p.t, 'requests');
  const bo = h.baseline(p.t, 'origin');
  const spread = (x: Baseline, min: number) => Math.max(1.4826 * x.mad, 0.15 * x.median, min / 2, 1);
  if (b) {
    const score = (req - b.median) / spread(b, minChange);
    const ratio = b.median ? req / b.median : Infinity;
    if (cls === 'off_peak' && req >= 0.75 * prof.peakLevel && req >= 2 * b.median && req - b.median >= minChange && score >= need) out.push({ kind: 'off_peak', value: req, expected: b.median, ratio, score });
    else if (score >= need && req >= SPIKE_RATIO * b.median && req - b.median >= minChange) out.push({ kind: 'spike', value: req, expected: b.median, ratio, score });
    else if (cls !== 'off_peak' && score <= -need && req <= DROP_RATIO * b.median && b.median - req >= minChange) out.push({ kind: 'drop', value: req, expected: b.median, ratio, score });
  }
  if (bo) {
    const score = (org - bo.median) / spread(bo, minChange);
    if (score >= need && org >= SPIKE_RATIO * bo.median && org - bo.median >= minChange) out.push({ kind: 'origin_spike', value: org, expected: bo.median, ratio: bo.median ? org / bo.median : Infinity, score });
  }
  const sb = h.shareBaseline(p.t);
  if (sb !== null && req >= minChange && org >= minChange) {
    const share = org / req;
    if (share - sb >= ORIGIN_SHARE_JUMP) out.push({ kind: 'origin_share', value: share, expected: sb, ratio: sb ? share / sb : Infinity, score: (share - sb) / ORIGIN_SHARE_JUMP });
  }
  return { judged: out, expected: b ? b.median / scale : null, expectedOrigin: bo ? bo.median / scale : null, cls };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const n0 = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : `${Math.round(x)}`);
function explain(f: Omit<Flag, 'explain'>, step: 'hour' | '5min'): string {
  const rate = step === '5min' ? ' (as an hourly rate)' : '';
  const when = f.hourClass === 'peak' ? 'a usual peak hour' : f.hourClass === 'off_peak' ? 'a usually quiet hour' : 'this hour';
  const times = Number.isFinite(f.ratio) ? `${f.ratio.toFixed(1)}×` : 'far above';
  switch (f.kind) {
    case 'spike': return `${n0(f.value)} requests an hour${rate}, ${times} the usual ${n0(f.expected)} for ${when} on this kind of day.`;
    case 'off_peak': return `${n0(f.value)} requests an hour${rate} at ${when} — as busy as a usual peak hour (${times} what is usual then: ${n0(f.expected)}).`;
    case 'drop': return `${n0(f.value)} requests an hour${rate}, ${Number.isFinite(f.ratio) ? pct(f.ratio) : '0%'} of the usual ${n0(f.expected)} for ${when}. A drop like this can mean an outage, a DNS or routing change, or blocked traffic.`;
    case 'origin_spike': return `${n0(f.value)} requests an hour${rate} reached the origin (not served from cache), ${times} the usual ${n0(f.expected)}. The origin carried far more than its pattern.`;
    case 'origin_share': return `${pct(f.value)} of requests reached the origin, against a usual ${pct(f.expected)} at this hour: the cache served much less than usual (a purge, a cache rule change, or traffic to uncacheable paths).`;
  }
}

/** Neighbouring flagged points of one kind as one event (gap of at most one point). */
function merge(points: { p: Point; judged: Judged[]; cls: HourClass; expected: number | null }[], window: WindowId, step: 'hour' | '5min'): Flag[] {
  const ms = STEP_MS[step];
  const out: Flag[] = [];
  const open = new Map<FlagKind, Omit<Flag, 'explain'> & { last: number }>();
  const close = (k: FlagKind) => { const f = open.get(k); if (!f) return; open.delete(k); const { last: _, ...rest } = f; out.push({ ...rest, explain: explain(rest, step) }); };
  for (const x of points) {
    const t = Date.parse(x.p.t);
    for (const k of [...open.keys()]) if (t - open.get(k)!.last > 2 * ms) close(k);
    for (const j of x.judged) {
      const cur = open.get(j.kind);
      const add = { total: x.p.requests, expectedTotal: x.expected ?? 0 };
      if (!cur) { open.set(j.kind, { kind: j.kind, window, start: x.p.t, end: new Date(t + ms).toISOString(), at: x.p.t, value: j.value, expected: j.expected, ratio: j.ratio, score: j.score, hourClass: x.cls, ...add, last: t }); continue; }
      cur.end = new Date(t + ms).toISOString(); cur.last = t; cur.total += add.total; cur.expectedTotal += add.expectedTotal;
      const worse = j.kind === 'drop' ? j.score < cur.score : j.score > cur.score;
      if (worse) Object.assign(cur, { at: x.p.t, value: j.value, expected: j.expected, ratio: j.ratio, score: j.score, hourClass: x.cls });
    }
  }
  for (const k of [...open.keys()]) close(k);
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

const WINDOWS: { id: WindowId; label: string; hours: number; fine: boolean }[] = [
  { id: '30d', label: 'Last 30 days', hours: 720, fine: false },
  { id: '7d', label: 'Last 7 days', hours: 168, fine: false },
  { id: '24h', label: 'Last 24 hours', hours: 24, fine: true },
  { id: '6h', label: 'Last 6 hours', hours: 6, fine: true },
];

/**
 * hourly: complete hours, oldest first (up to 30 days); fine: complete 5-minute points of the last
 * 24 hours. `now` ends every window. Notes say what could not be read.
 */
export function analyse(hourly: Point[], fine: Point[], now: Date, notes: { hourly?: string; fine?: string } = {}): PatternAnalysis {
  const hist = new History(hourly);
  const profile = profileOf(hourly);
  const minChange = Math.max(MIN_REQUESTS, 0.05 * profile.peakLevel);
  const end = now.getTime();
  const windows = WINDOWS.map((w): WindowSummary => {
    const useFine = w.fine && fine.length > 0;
    const step: 'hour' | '5min' = useFine ? '5min' : 'hour';
    const scale = useFine ? 12 : 1;
    const src = (useFine ? fine : hourly).filter((p) => Date.parse(p.t) >= end - w.hours * HOUR_MS);
    const base = { id: w.id, label: w.label, step };
    if (!src.length) return { ...base, available: false, note: (useFine ? notes.fine : notes.hourly) ?? 'No traffic could be read for this window.', since: null, until: null, points: [], total: 0, expectedTotal: null, originShare: null, expectedOriginShare: null, originStatus: 'unknown', flags: [] };
    const judged = src.map((p) => ({ p, ...judge(p, hist, profile, minChange, scale, useFine) }));
    const total = src.reduce((a, p) => a + p.requests, 0);
    const origin = src.reduce((a, p) => a + metricOf(p, 'origin'), 0);
    const withExp = judged.filter((x) => x.expected !== null && x.expectedOrigin !== null);
    const expTotal = withExp.length === judged.length ? withExp.reduce((a, x) => a + x.expected!, 0) : null;
    const expOrigin = withExp.length ? withExp.reduce((a, x) => a + x.expectedOrigin!, 0) : null;
    const expReq = withExp.length ? withExp.reduce((a, x) => a + x.expected!, 0) : null;
    const share = total ? origin / total : null;
    const expShare = expOrigin !== null && expReq ? expOrigin / expReq : null;
    const originStatus: WindowSummary['originStatus'] = share === null ? 'unknown' : expShare !== null && share - expShare >= ORIGIN_WINDOW_JUMP ? 'unusual' : share >= HIGH_ORIGIN ? 'high' : 'normal';
    const flags = merge(judged.map((x) => ({ p: x.p, judged: x.judged, cls: x.cls, expected: x.expected })), w.id, step);
    return {
      ...base, available: true, since: src[0].t, until: new Date(Date.parse(src[src.length - 1].t) + STEP_MS[step]).toISOString(),
      ...(useFine || !w.fine || !notes.fine ? {} : { note: `5-minute data could not be read (${notes.fine}); hourly points are shown.` }),
      points: judged.map((x) => ({ t: x.p.t, requests: x.p.requests, origin: metricOf(x.p, 'origin'), bytes: x.p.bytes, originBytes: metricOf(x.p, 'originBytes'), expected: x.expected, expectedOrigin: x.expectedOrigin, flags: x.judged.map((j) => j.kind) })),
      total, expectedTotal: expTotal, originShare: share, expectedOriginShare: expShare, originStatus, flags,
    };
  });
  return { tz: TZ, profile, windows, minChange };
}
