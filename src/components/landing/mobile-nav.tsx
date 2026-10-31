'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';

/** The header's section links on small screens: a disclosure that closes on a pick, Escape or outside click. */
export function MobileNav({ links }: { links: { href: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); };
  }, [open]);

  return (
    <div ref={wrap} className="lg:hidden">
      <button ref={button} type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}
        className="grid size-11 place-items-center rounded-[10px] text-ink-2 transition-colors hover:bg-raised hover:text-ink">
        {open ? <X aria-hidden="true" className="size-5" /> : <Menu aria-hidden="true" className="size-5" />}
        <span className="sr-only">{open ? 'Close menu' : 'Menu'}</span>
      </button>
      <div id={id} hidden={!open} className="absolute inset-x-0 top-full border-b border-line bg-canvas px-4 pb-4 shadow-[0_24px_40px_-24px_rgb(0_0_0/0.8)]">
        <ul className="mx-auto max-w-7xl divide-y divide-line">
          {links.map((l) => (
            <li key={l.href}>
              <a href={l.href} onClick={() => setOpen(false)} className="flex min-h-12 items-center text-[15px] text-ink-2 hover:text-ink">{l.label}</a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
