import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, eastern, median, profileOf, type Point } from '@/lib/traffic-anomaly';

// Synthetic traffic with a daily rhythm in US Eastern time — busy 9 am to 5 pm, quiet 1 to 5 am —
// and events planted where the test can find them. Test data only.

const NOW = Date.parse('2026-11-02T17:00:00Z'); // 12 pm Eastern (EST), a Monday
const H = 3_600_000;
/** Usual requests an hour at an Eastern hour, with a little day-to-day noise. */
function usual(t: number, wobble = 0) {
  const h = eastern(new Date(t).toISOString()).hour;
  const base = h >= 9 && h < 17 ? 1000 : h >= 1 && h < 5 ? 50 : 300;
  return Math.round(base * (1 + wobble));
}
const pt = (t: number, requests: number, cachedShare = 0.7): Point => ({ t: new Date(t).toISOString(), requests, cached: Math.round(requests * cachedShare), bytes: requests * 20_000, cachedBytes: Math.round(requests * cachedShare) * 20_000 });
/** 30 days of complete hours ending at NOW; `edit` changes a point by its hours-ago. */
function hourly(edit: (ago: number, p: Point) => Point = (_, p) => p) {
  const out: Point[] = [];
  for (let ago = 720; ago >= 1; ago--) {
    const t = NOW - ago * H;
    out.push(edit(ago, pt(t, usual(t, ((ago * 7919) % 11) / 100 - 0.05))));
  }
  return out;
}
/** The last 24 hours in 5-minute points, each a twelfth of the usual hour. */
function fine(edit: (agoMin: number, p: Point) => Point = (_, p) => p) {
  const out: Point[] = [];
  for (let ago = 24 * 60; ago >= 5; ago -= 5) { const t = NOW - ago * 60_000; out.push(edit(ago, pt(t, Math.round(usual(t) / 12)))); }
  return out;
}
const flags = (a: ReturnType<typeof analyse>, w: string) => a.windows.find((x) => x.id === w)!.flags;

test('eastern time and the daily profile: peak and quiet hours', () => {
  assert.deepEqual(eastern('2026-11-02T17:00:00Z'), { hour: 12, weekend: false, day: '2026-11-02' });
  assert.equal(eastern('2026-07-01T16:00:00Z').hour, 12, 'daylight saving time');
  assert.equal(median([5, 1, 3]), 3);
  const p = profileOf(hourly());
  assert.ok(p.peakHours.every((h) => h >= 9 && h < 17) && p.peakHours.length >= 6, JSON.stringify(p.peakHours));
  assert.ok(p.quietHours.every((h) => h >= 1 && h < 5), JSON.stringify(p.quietHours));
  assert.ok(p.peakLevel >= 950 && p.peakLevel <= 1050, String(p.peakLevel));
});

test('normal traffic, busy hours included, is not flagged', () => {
  const a = analyse(hourly(), fine(), new Date(NOW));
  for (const w of a.windows) assert.deepEqual(w.flags.map((f) => `${w.id} ${f.kind} ${f.at}`), []);
  const d30 = a.windows.find((w) => w.id === '30d')!;
  assert.equal(d30.points.length, 720);
  assert.equal(d30.originStatus, 'normal');
  assert.ok(Math.abs(d30.originShare! - 0.3) < 0.02);
});

test('a spike at a normal hour is flagged in every window that contains it', () => {
  // 3 hours ago is 9 am Eastern: a peak hour (usual ~1,000). 5× that is a spike.
  const a = analyse(hourly((ago, p) => (ago === 3 ? pt(Date.parse(p.t), 5000) : p)), fine(), new Date(NOW));
  for (const w of ['30d', '7d']) {
    const f = flags(a, w).find((x) => x.kind === 'spike');
    assert.ok(f, `${w}: ${JSON.stringify(flags(a, w))}`);
    assert.equal(f.at, new Date(NOW - 3 * H).toISOString());
    assert.ok(f.ratio > 4 && f.expected > 900 && f.expected < 1100, JSON.stringify(f));
    assert.match(f.explain, /requests an hour.*usual/);
  }
});

test('busy at a quiet hour: off-peak traffic at peak level', () => {
  // 3 am Eastern on the last day (13 hours before noon) at 1,000 requests instead of ~50.
  const a = analyse(hourly((ago, p) => (ago === 9 ? pt(Date.parse(p.t), 1000) : p)), fine(), new Date(NOW));
  assert.equal(eastern(new Date(NOW - 9 * H).toISOString()).hour, 3);
  const f = flags(a, '7d').find((x) => x.kind === 'off_peak');
  assert.ok(f, JSON.stringify(flags(a, '7d')));
  assert.equal(f.hourClass, 'off_peak');
  assert.match(f.explain, /usually quiet hour/);
});

test('a drop at peak hours is flagged; a quiet-hour dip is not', () => {
  const a = analyse(hourly((ago, p) => (ago === 4 || ago === 3 ? pt(Date.parse(p.t), 50) : ago === 10 ? pt(Date.parse(p.t), 0) : p)), fine(), new Date(NOW));
  const drops = flags(a, '24h').filter((x) => x.kind === 'drop');
  // 24h uses 5-minute points (unchanged here), so look at the hourly 7-day window.
  const d7 = flags(a, '7d').filter((x) => x.kind === 'drop');
  assert.equal(d7.length, 1, JSON.stringify(d7));
  assert.equal(d7[0].start, new Date(NOW - 4 * H).toISOString(), 'two neighbouring hours make one event');
  assert.equal(d7[0].end, new Date(NOW - 2 * H).toISOString());
  assert.equal(drops.length, 0);
});

test('origin load: a spike in requests that reached the origin, and a jump in the origin share', () => {
  // The last 2 hours: same requests, nothing from cache (origin 3.3× usual, share 100% vs 30%).
  const a = analyse(hourly((ago, p) => (ago <= 2 ? pt(Date.parse(p.t), p.requests, 0) : p)), fine(), new Date(NOW));
  const kinds = new Set(flags(a, '7d').map((x) => x.kind));
  assert.ok(kinds.has('origin_spike') && kinds.has('origin_share') && !kinds.has('spike'), [...kinds].join(','));
  const share = flags(a, '7d').find((x) => x.kind === 'origin_share')!;
  assert.ok(share.value === 1 && share.expected > 0.25 && share.expected < 0.35, JSON.stringify(share));
  assert.match(share.explain, /cache served much less/);
  // The 6-hour window's share: unusual (well above its usual share).
  const a6 = analyse(hourly(), fine((ago, p) => (ago <= 180 ? pt(Date.parse(p.t), p.requests, 0) : p)), new Date(NOW));
  const w6 = a6.windows.find((w) => w.id === '6h')!;
  assert.equal(w6.originStatus, 'unusual');
  assert.ok(w6.originShare! > 0.6, String(w6.originShare));
});

test('5-minute windows: a short burst in the last 6 hours, judged as an hourly rate', () => {
  const a = analyse(hourly(), fine((ago, p) => (ago === 30 || ago === 25 ? pt(Date.parse(p.t), p.requests * 20) : p)), new Date(NOW));
  const w6 = a.windows.find((w) => w.id === '6h')!;
  assert.equal(w6.step, '5min');
  assert.equal(w6.points.length, 72);
  const f = w6.flags.find((x) => x.kind === 'spike');
  assert.ok(f, JSON.stringify(w6.flags));
  assert.equal(f.start, new Date(NOW - 30 * 60_000).toISOString());
  assert.equal(f.end, new Date(NOW - 20 * 60_000).toISOString());
  assert.ok(f.value > 15_000, 'an hourly rate');
  assert.ok(a.windows.find((w) => w.id === '24h')!.flags.some((x) => x.kind === 'spike'));
});

test('small zones: a change smaller than the minimum is never flagged', () => {
  const tiny = hourly((_, p) => pt(Date.parse(p.t), Math.round(p.requests / 100)));
  const a = analyse(tiny.map((p, i) => (i === tiny.length - 2 ? { ...p, requests: p.requests * 4, cached: 0 } : p)), [], new Date(NOW));
  assert.deepEqual(a.windows.flatMap((w) => w.flags), []);
  assert.equal(a.windows.find((w) => w.id === '6h')!.step, 'hour', 'without 5-minute data the hourly points are used');
});

test('too little history: no baseline, no flag, and the window says what is missing', () => {
  const a = analyse(hourly().slice(-30), [], new Date(NOW), { fine: 'refused' });
  assert.deepEqual(a.windows.flatMap((w) => w.flags), []);
  const w24 = a.windows.find((w) => w.id === '24h')!;
  assert.match(w24.note ?? '', /5-minute data could not be read \(refused\)/);
  assert.ok(w24.points.every((p) => p.expected === null || typeof p.expected === 'number'));
});
