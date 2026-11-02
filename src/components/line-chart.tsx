'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './ui';

// A line chart: one y axis, 2px lines, a legend (every series named, so colour is never the only cue),
// a crosshair with a tooltip on hover and on the arrow keys, and optional markers above flagged points.
// Drawn in SVG at the box's real width (measured), so lines and text never stretch. Colours come from
// CHART_COLORS: the first three slots of the dataviz reference palette, dark steps (validated as a set
// against the console's surface), and its red for a fourth series — which is then dashed.

/** Series colours, in this order: blue, orange, aqua, red. */
export const CHART_COLORS = { blue: '#3987e5', orange: '#d95926', aqua: '#199e70', red: '#e66767', usual: '#868a93' } as const;

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
  /** Dashed: the "usual" line, or a fourth series (secondary cue besides colour). */
  dashed?: boolean;
}
export interface ChartMarker { index: number; label: string; tone: 'bad' | 'warn' | 'info' }

const TONE: Record<ChartMarker['tone'], string> = { bad: '#f0566a', warn: '#d9b04c', info: '#b8c2d0' };
const PAD = { top: 18, right: 12, bottom: 22, left: 52 };

/** A round top for the y axis: 1, 2, 2.5 or 5 × a power of ten. */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function LineChart({ x, series, markers = [], formatX, formatTip, formatY, height = 200, onPick, label, pickHint }: {
  x: string[];
  series: LineSeries[];
  markers?: ChartMarker[];
  /** Axis label for x[i] (short). */
  formatX: (v: string, i: number) => string;
  /** Tooltip heading for x[i] (full). */
  formatTip: (v: string, i: number) => string;
  formatY: (n: number) => string;
  height?: number;
  onPick?: (i: number) => void;
  /** What the chart shows, for screen readers. */
  label: string;
  pickHint?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [at, setAt] = useState<number | null>(null);
  const id = useId();
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // Fires once at once with the current size, then on every resize.
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = x.length;
  const top = useMemo(() => niceMax(Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)))), [series]);
  const plotW = Math.max(1, w - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const xs = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const ys = (v: number) => PAD.top + plotH - (v / top) * plotH;
  // A gap (null) lifts the pen: no line is drawn across what was not read.
  const paths = series.map((s) => {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const xTicks = n <= 1 ? [0] : [...new Set([0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round(((n - 1) * 3) / 4), n - 1])];
  const pickAt = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || !n) return null;
    return Math.max(0, Math.min(n - 1, Math.round(((clientX - r.left - PAD.left) / plotW) * (n - 1))));
  };
  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    const step = e.shiftKey ? Math.max(1, Math.round(n / 10)) : 1;
    const next = e.key === 'ArrowRight' ? Math.min(n - 1, (at ?? -1) + step) : e.key === 'ArrowLeft' ? Math.max(0, (at ?? n) - step) : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (next !== null) { e.preventDefault(); setAt(next); }
    else if ((e.key === 'Enter' || e.key === ' ') && at !== null && onPick) { e.preventDefault(); onPick(at); }
    else if (e.key === 'Escape') setAt(null);
  };
  const markAt = useMemo(() => new Map(markers.map((m) => [m.index, m])), [markers]);
  const tipLeft = at === null ? 0 : xs(at);

  return (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" aria-hidden>
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <svg width="18" height="6" className="shrink-0"><line x1="0" y1="3" x2="18" y2="3" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '4 3' : undefined} strokeLinecap="round" /></svg>
            {s.label}
          </span>
        ))}
        {markers.length > 0 && <span className="inline-flex items-center gap-1.5"><span className="size-2 rotate-45 bg-[#f0566a]" />Flagged</span>}
        {pickHint && onPick && <span className="text-faint">{pickHint}</span>}
      </div>
      <div ref={box} className="relative" style={{ height }}>
        {w > 0 && (
          <svg width={w} height={height} role="img" aria-label={label} aria-describedby={`${id}-tip`} tabIndex={0}
            className="block cursor-crosshair rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onMouseMove={(e) => setAt(pickAt(e.clientX))} onMouseLeave={() => setAt(null)} onKeyDown={onKey} onBlur={() => setAt(null)}
            onClick={(e) => { const i = pickAt(e.clientX); if (i !== null && onPick) onPick(i); }}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={ys(t)} y2={ys(t)} stroke="currentColor" className={t === 0 ? 'text-line-strong' : 'text-line'} strokeDasharray={t === 0 ? undefined : '3 4'} />
                <text x={PAD.left - 8} y={ys(t)} dy="0.32em" textAnchor="end" className="fill-faint text-[10.5px] tabular-nums">{formatY(t)}</text>
              </g>
            ))}
            {xTicks.map((i) => (
              <text key={i} x={xs(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="fill-faint text-[10.5px]">{formatX(x[i], i)}</text>
            ))}
            {series.map((s, k) => (
              <path key={s.key} d={paths[k]} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? '5 4' : undefined} />
            ))}
            {markers.map((m) => (
              <g key={`${m.index}:${m.label}`} transform={`translate(${xs(m.index)},${PAD.top - 9})`}>
                <rect x={-4} y={-4} width={8} height={8} transform="rotate(45)" fill={TONE[m.tone]} stroke="var(--color-surface)" strokeWidth={2} />
                <title>{m.label}</title>
              </g>
            ))}
            {at !== null && (
              <g pointerEvents="none">
                <line x1={xs(at)} x2={xs(at)} y1={PAD.top} y2={PAD.top + plotH} stroke="currentColor" className="text-muted" strokeWidth={1} />
                {series.map((s) => (s.values[at] === null ? null : <circle key={s.key} cx={xs(at)} cy={ys(s.values[at]!)} r={4} fill={s.color} stroke="var(--color-surface)" strokeWidth={2} />))}
              </g>
            )}
          </svg>
        )}
        <div id={`${id}-tip`} role="status" aria-live="polite" className={cx('pointer-events-none absolute top-0 z-20 w-56 rounded-lg border border-line-strong bg-surface px-3 py-2 text-xs shadow-pop', at === null && 'sr-only')}
          style={at === null ? undefined : { left: tipLeft, transform: `translateX(${tipLeft < w / 3 ? '8px' : tipLeft > (w * 2) / 3 ? 'calc(-100% - 8px)' : '-50%'})` }}>
          {at !== null && (
            <>
              <div className="mb-1 font-medium text-ink">{formatTip(x[at], at)}</div>
              {series.map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-3 text-ink-2">
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-muted"><span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} /><span className="truncate">{s.label}</span></span>
                  <span className="tabular-nums">{s.values[at] === null ? '—' : formatY(s.values[at]!)}</span>
                </div>
              ))}
              {markAt.get(at) && <div className="mt-1 border-t border-line pt-1 text-bad">{markAt.get(at)!.label}</div>}
              {onPick && pickHint && <div className="mt-1 text-[11px] text-faint">{pickHint}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A table of the chart's numbers (the accessible view), collapsed by default. */
export function ChartTable({ title, head, rows }: { title: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted hover:text-ink">{title}</summary>
      <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-line">
        <table className="w-full text-left text-[12px] tabular-nums">
          <thead className="sticky top-0 bg-raised text-muted"><tr>{head.map((h) => <th key={h} className="px-3 py-1.5 font-medium">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-line/50">{r.map((c, k) => <td key={k} className="px-3 py-1">{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}
