'use client';

import { useEffect } from 'react';

/**
 * Calls `fn` every `ms` while `on`: the next call is timed from the end of the last one, so
 * calls never overlap. Paused while the tab is hidden; called at once when it is shown again.
 * `now` also calls at start. A new `fn` (keep it in useCallback) starts over; leaving cancels
 * the call in flight through its `signal`.
 */
export function usePoll(fn: (signal: AbortSignal) => unknown, ms: number, { on = true, now = true } = {}) {
  useEffect(() => {
    if (!on) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctl: AbortController | undefined;
    let stopped = false;
    const run = async () => {
      timer = undefined;
      ctl = new AbortController();
      try { await fn(ctl.signal); } catch { /* the caller shows its own errors */ }
      ctl = undefined;
      if (!stopped) schedule();
    };
    const schedule = () => { if (!timer && !ctl && !document.hidden) timer = setTimeout(run, ms); };
    const onVisibility = () => {
      clearTimeout(timer); timer = undefined;
      if (!document.hidden && !ctl) void run();
    };
    if (now) void run(); else schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true; clearTimeout(timer); ctl?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fn, ms, on, now]);
}
