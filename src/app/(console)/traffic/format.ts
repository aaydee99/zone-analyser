// Number and date formatting shared by the traffic page and its zone detail.

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
export const whole = new Intl.NumberFormat();
export const num = (n: number) => (n < 10_000 ? whole.format(n) : compact.format(n));

export function bytes(b: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (b >= 1000 && i < units.length - 1) { b /= 1000; i++; }
  return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${units[i]}`;
}

export const pct = (part: number, of: number) => (of ? `${((part / of) * 100).toFixed(1)}%` : '—');
export const dayLabel = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
