'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

// Shared motion helpers for the landing page's small client components.

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** True when the visitor asked for less motion. On the server (and before hydration) it is true,
 *  so the static HTML always shows every effect's final state. */
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => true);
}

/** True while `el` is at least `threshold` visible. Starts false; stays false without IntersectionObserver. */
export function useInView<T extends Element>(el: T | null, { threshold = 0.25, once = false, rootMargin = '0px' } = {}) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => {
      setInView(entry.isIntersecting);
      if (entry.isIntersecting && once) io.disconnect();
    }, { threshold, rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [el, threshold, once, rootMargin]);
  return inView;
}

/** True while the tab is visible, so timers can stop in background tabs. */
export function usePageVisible() {
  return useSyncExternalStore(
    (cb) => { document.addEventListener('visibilitychange', cb); return () => document.removeEventListener('visibilitychange', cb); },
    () => document.visibilityState === 'visible',
    () => true,
  );
}
