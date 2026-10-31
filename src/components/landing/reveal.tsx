'use client';

import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react';
import { useReducedMotion } from './motion';

/**
 * Plays a scroll entrance once. The server HTML is the final state (visible), so the page reads fine
 * without JS and under reduced motion; only elements that start below the fold are "armed" (hidden),
 * then released when they scroll in. What the entrance looks like is CSS: `[data-reveal]` rules in
 * the Landing section of globals.css, keyed on `data-reveal="armed" | "in"`.
 */
export function Reveal({ as: Tag = 'div', className, children, threshold = 0.2, id }: {
  as?: ElementType; className?: string; children: ReactNode; threshold?: number; id?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const reduced = useReducedMotion();
  const [state, setState] = useState<'static' | 'armed' | 'in'>('static');

  useEffect(() => {
    const el = ref.current;
    if (!el || reduced || typeof IntersectionObserver === 'undefined') return;
    // Already on screen when the page loads: leave it alone, nothing should blink.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return;
    setState('armed');
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setState('in'); io.disconnect(); }
    }, { threshold, rootMargin: '0px 0px -8% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [reduced, threshold]);

  return <Tag ref={ref} id={id} className={className} data-reveal={state}>{children}</Tag>;
}
