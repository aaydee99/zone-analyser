// Bot scores (Cloudflare Bot Management): how likely a request came from a bot, 1 (automated) to 99
// (human). Cloudflare's bands: 1 automated, 2–29 likely automated, 30–99 likely human. 0 (or no
// score) means the request was not scored. Pure: shared by server, page and tests.

import type { DetailRow } from './traffic-types';

export type BotBand = 'automated' | 'likely_automated' | 'likely_human' | 'not_scored';
export const BOT_BANDS: { key: BotBand; label: string; range: string }[] = [
  { key: 'automated', label: 'Automated', range: 'score 1' },
  { key: 'likely_automated', label: 'Likely automated', range: 'scores 2–29' },
  { key: 'likely_human', label: 'Likely human', range: 'scores 30–99' },
  { key: 'not_scored', label: 'Not scored', range: 'no score (0)' },
];

/** The band of one score (a number, or Cloudflare's value as text). */
export function bandOf(score: unknown): BotBand {
  const n = Number(score);
  if (!Number.isFinite(n) || n < 1 || n > 99) return 'not_scored';
  return n === 1 ? 'automated' : n < 30 ? 'likely_automated' : 'likely_human';
}

export const BAND_LABEL: Record<BotBand, string> = Object.fromEntries(BOT_BANDS.map((b) => [b.key, b.label])) as Record<BotBand, string>;

/** Score ranges for the distribution: 1 on its own (automated), then 2–9, 10–19 … 90–99. */
export const SCORE_RANGES: { from: number; to: number; label: string }[] = [
  { from: 1, to: 1, label: '1' },
  { from: 2, to: 9, label: '2–9' },
  ...Array.from({ length: 9 }, (_, i) => ({ from: (i + 1) * 10, to: (i + 1) * 10 + 9, label: `${(i + 1) * 10}–${(i + 1) * 10 + 9}` })),
];

export interface BotSummary {
  /** Requests counted in the breakdown, and those of them that were scored (1–99). */
  total: number; scored: number;
  bands: { key: BotBand; label: string; range: string; count: number }[];
  /** The distribution of scored requests over SCORE_RANGES. */
  ranges: { label: string; from: number; to: number; count: number }[];
  /** Of the scored requests: the average score and the median (null when none were scored). */
  mean: number | null; median: number | null;
}

/** The summary of a `botScore` breakdown (one row per score, with its request count). */
export function botSummary(rows: DetailRow[]): BotSummary {
  const counts = new Map<BotBand, number>(BOT_BANDS.map((b) => [b.key, 0]));
  const ranges = SCORE_RANGES.map((r) => ({ ...r, count: 0 }));
  const scored: { score: number; count: number }[] = [];
  let total = 0;
  for (const r of rows) {
    const band = bandOf(r.dims.botScore);
    counts.set(band, counts.get(band)! + r.count);
    total += r.count;
    if (band === 'not_scored') continue;
    const score = Number(r.dims.botScore);
    scored.push({ score, count: r.count });
    const range = ranges.find((x) => score >= x.from && score <= x.to);
    if (range) range.count += r.count;
  }
  const n = scored.reduce((s, x) => s + x.count, 0);
  let median: number | null = null;
  if (n) {
    scored.sort((a, b) => a.score - b.score);
    let seen = 0;
    for (const x of scored) { seen += x.count; if (seen >= n / 2) { median = x.score; break; } }
  }
  return {
    total, scored: n,
    bands: BOT_BANDS.map((b) => ({ ...b, count: counts.get(b.key)! })),
    ranges, mean: n ? Math.round((scored.reduce((s, x) => s + x.score * x.count, 0) / n) * 10) / 10 : null, median,
  };
}
