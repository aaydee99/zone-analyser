// Every count the console shows goes through here: 999, 1.2k, 3.4M, 2.1B, 1.5T. Byte sizes use KB/MB/GB instead.

const small = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const UNITS = ['', 'k', 'M', 'B', 'T'] as const;

/** 1234 → "1.2k", 3_400_000 → "3.4M"; under 1,000 the number is shown as it is. */
export function compactNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  let v = Math.abs(n), u = 0;
  if (v < 1000) return small.format(n);
  while (v >= 1000 && u < UNITS.length - 1) { v /= 1000; u++; }
  let r = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  // 999.96k rounds to 1000k: show it as 1M.
  if (r >= 1000 && u < UNITS.length - 1) { r = 1; u++; }
  return `${n < 0 ? '−' : ''}${r}${UNITS[u]}`;
}

/** A drop-in for `new Intl.NumberFormat()` where a page calls `.format(n)`. */
export const whole = { format: compactNum };
