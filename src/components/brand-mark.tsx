// The Edgekeep mark: a keep's battlements on an "E" whose middle bar floats free (the copy you
// keep). Chrome body, gold bar. Same geometry as public/brand/*.svg, coloured from the theme
// tokens. Decorative: the brand name always sits next to it as text. `intro` plays the build-in
// once (the body rises, the bar slides home); reduced motion skips it.

export function BrandMark({ className = 'h-6', mono = false, intro = false }: { className?: string; mono?: boolean; intro?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="12 10 40 44" className={`w-auto ${intro ? 'ek-intro' : ''} ${className}`}>
      {!mono && (
        <defs>
          <linearGradient id="edgekeep-mark-body" x1="12" y1="10" x2="52" y2="54" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--brand-chrome-hi)" />
            <stop offset="0.42" stopColor="var(--brand-chrome)" />
            <stop offset="0.52" stopColor="var(--brand-chrome-hi)" />
            <stop offset="1" stopColor="var(--brand-chrome-lo)" />
          </linearGradient>
          <linearGradient id="edgekeep-mark-bar" x1="0" y1="31.5" x2="0" y2="39.5" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--brand-gold-hi)" />
            <stop offset="1" stopColor="var(--brand-gold-deep)" />
          </linearGradient>
        </defs>
      )}
      <path className="ek-body" d="M12 10H20V17H28V10H36V17H44V10H52V25H20V46H52V54H12Z" fill={mono ? 'currentColor' : 'url(#edgekeep-mark-body)'} />
      <path className="ek-bar" d="M24 31.5H46V39.5H24Z" fill={mono ? 'currentColor' : 'url(#edgekeep-mark-bar)'} />
    </svg>
  );
}
