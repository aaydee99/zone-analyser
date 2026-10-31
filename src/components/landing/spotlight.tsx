'use client';

import { useEffect } from 'react';

// One pointer listener for the whole page: the tile under the pointer gets --mx/--my, which its
// gold spotlight and edge light (globals.css, .lp-tile) are drawn from. Renders nothing.
export function Spotlight() {
  useEffect(() => {
    if (!window.matchMedia('(hover: hover)').matches) return;
    let frame = 0, ev: PointerEvent | null = null;
    const apply = () => {
      frame = 0;
      const tile = ev && (ev.target as Element | null)?.closest?.('.lp-tile') as HTMLElement | null;
      if (!tile || !ev) return;
      const r = tile.getBoundingClientRect();
      tile.style.setProperty('--mx', `${ev.clientX - r.left}px`);
      tile.style.setProperty('--my', `${ev.clientY - r.top}px`);
    };
    const move = (e: PointerEvent) => { ev = e; if (!frame) frame = requestAnimationFrame(apply); };
    document.addEventListener('pointermove', move, { passive: true });
    return () => { document.removeEventListener('pointermove', move); cancelAnimationFrame(frame); };
  }, []);
  return null;
}
