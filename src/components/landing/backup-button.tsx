'use client';

import { useEffect, useRef, useState } from 'react';
import { CloudUpload } from 'lucide-react';

/** A demo of the console's backup button: it morphs from start → progress → a drawn check. Runs nothing. */
export function BackupButton() {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const start = () => {
    if (phase !== 'idle') return;
    setPhase('running');
    timers.current.push(window.setTimeout(() => setPhase('done'), 1600));
    timers.current.push(window.setTimeout(() => setPhase('idle'), 5200));
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <button type="button" onClick={start} aria-disabled={phase !== 'idle'} data-phase={phase} className="lp-morph">
        <span aria-hidden="true" className="lp-morph-fill" />
        <span className="lp-morph-label">
          {phase === 'done' ? (
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4"><path className="lp-check" d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" pathLength={1} /></svg>
          ) : <CloudUpload aria-hidden="true" className="size-4" />}
          {phase === 'idle' ? 'Back up example.com' : phase === 'running' ? 'Backing up…' : 'Backup complete'}
        </span>
      </button>
      <span role="status" className="font-mono text-[11.5px] text-faint">
        {phase === 'done' ? '42 resources · .tf + JSON · demo' : phase === 'running' ? 'Exporting with cf-terraforming…' : 'Try it: a demo, nothing runs'}
      </span>
    </div>
  );
}
