// Zone timeline: spike detection over a time series. Pure functions, shared by server and client
// (and the unit tests) — no Node imports. A bucket is a spike when it is well above the window's
// typical bucket: at least `min` events, at least three times the median, and more than six robust
// standard deviations (MAD × 1.4826) above it. Neighbouring spike buckets are one spike. Simple on
// purpose, so the page can say exactly why a bucket was flagged.

export interface Point { t: string; v: number }
export interface Spike { start: string; end: string; peakAt: string; peak: number; total: number; typical: number; threshold: number }

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Every bucket of [since, until), zero where the series has none (Cloudflare leaves empty buckets out). */
export function fillBuckets(points: Point[], since: string, until: string, bucketMs: number): Point[] {
  const by = new Map<number, number>();
  for (const p of points) {
    const t = Math.floor(Date.parse(p.t) / bucketMs) * bucketMs;
    if (!Number.isNaN(t)) by.set(t, (by.get(t) ?? 0) + p.v);
  }
  const out: Point[] = [];
  const end = Date.parse(until);
  for (let t = Math.floor(Date.parse(since) / bucketMs) * bucketMs; t < end; t += bucketMs) out.push({ t: new Date(t).toISOString(), v: by.get(t) ?? 0 });
  return out;
}

/** The threshold a bucket must reach, and the typical (median) bucket. */
export function thresholdOf(values: number[], min: number): { typical: number; threshold: number } {
  const typical = median(values);
  const mad = median(values.map((v) => Math.abs(v - typical))) * 1.4826;
  return { typical, threshold: Math.max(min, typical * 3, typical + 6 * mad) };
}

/** Spikes in a filled series (see fillBuckets). */
export function findSpikes(series: Point[], min = 20): Spike[] {
  const { typical, threshold } = thresholdOf(series.map((p) => p.v), min);
  const out: Spike[] = [];
  let cur: Spike | null = null;
  for (const p of series) {
    if (p.v >= threshold) {
      if (!cur) { cur = { start: p.t, end: p.t, peakAt: p.t, peak: p.v, total: 0, typical, threshold }; out.push(cur); }
      cur.end = p.t; cur.total += p.v;
      if (p.v > cur.peak) { cur.peak = p.v; cur.peakAt = p.t; }
    } else cur = null;
  }
  return out;
}
