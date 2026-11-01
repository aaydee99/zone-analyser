'use client';

import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { useInView, usePageVisible, useReducedMotion } from './motion';

/** The verbs the headline cycles through: each one is a section of the console. */
const VERBS = ['Audit', 'Monitor', 'Investigate', 'Undo', 'Back up'] as const;
const EVERY_MS = 2600;

/**
 * The page's one h1. Screen readers get the whole sentence once (sr-only); the rotating verb is
 * aria-hidden. It stops under reduced motion, off screen, in a background tab, and on Pause.
 */
export function HeroHeadline() {
  const ref = useRef<HTMLDivElement>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const reduced = useReducedMotion();
  const visible = usePageVisible();
  const onScreen = useInView(el, { threshold: 0 });
  const [paused, setPaused] = useState(false);
  const [i, setI] = useState(0);
  const running = !reduced && !paused && visible && onScreen;

  useEffect(() => { setEl(ref.current); }, []);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setI((n) => (n + 1) % VERBS.length), EVERY_MS);
    return () => window.clearInterval(t);
  }, [running]);

  const verb = reduced ? VERBS[0] : VERBS[i];

  return (
    <div ref={ref} className="lp-enter relative" style={{ '--lp-d': '60ms' } as React.CSSProperties}>
      <h1 id="hero-title" className="lp-display text-ink">
        <span className="sr-only">Audit, monitor, investigate, undo and back up your Cloudflare edge.</span>
        <span aria-hidden="true" className="block">
          <span className="lp-rotor">
            <span key={verb} className="lp-rotor-word lp-gold">{verb}</span>
          </span>
          <span className="lp-chrome block">your Cloudflare edge.</span>
        </span>
      </h1>
      {/* Always laid out (no shift after hydration); invisible, and out of the a11y tree, under reduced motion. */}
      <button type="button" onClick={() => setPaused((p) => !p)} aria-pressed={paused} tabIndex={reduced ? -1 : undefined}
          className={`${reduced ? 'invisible' : ''} mt-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-3 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink`}>
          {paused ? <Play aria-hidden="true" className="size-3.5" /> : <Pause aria-hidden="true" className="size-3.5" />}
          {paused ? 'Play headline' : 'Pause headline'}
      </button>
    </div>
  );
}
