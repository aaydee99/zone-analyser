// The Castellan mark: the castellan's key. A chrome ring (the "C") whose lower stroke runs on as
// a gold key shaft, ending in teeth that stand like battlements. Same geometry as
// public/brand/*.svg, coloured from the theme tokens. Decorative: the brand name always sits next
// to it as text. `intro` plays the build-in once (the ring draws itself, the key slides home);
// reduced motion skips it.

export function BrandMark({ className = 'h-6', mono = false, intro = false }: { className?: string; mono?: boolean; intro?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="8 14 48 36" className={`w-auto ${intro ? 'mark-intro' : ''} ${className}`}>
      {!mono && (
        <defs>
          <linearGradient id="castellan-mark-ring" x1="12" y1="18" x2="40" y2="46" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--brand-chrome-hi)" />
            <stop offset="0.45" stopColor="var(--brand-chrome)" />
            <stop offset="0.55" stopColor="var(--brand-chrome-hi)" />
            <stop offset="1" stopColor="var(--brand-chrome-lo)" />
          </linearGradient>
          <linearGradient id="castellan-mark-key" x1="26" y1="33" x2="56" y2="50" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--brand-gold-hi)" />
            <stop offset="1" stopColor="var(--brand-gold-deep)" />
          </linearGradient>
        </defs>
      )}
      <path className="mark-ring" pathLength={1} d="M36.72 23A14 14 0 1 0 26 46" fill="none" strokeWidth="8"
        stroke={mono ? 'currentColor' : 'url(#castellan-mark-ring)'} />
      <path className="mark-key" d="M26 42H45V36H49V42H51V33H56V50H26Z" fill={mono ? 'currentColor' : 'url(#castellan-mark-key)'} />
    </svg>
  );
}
