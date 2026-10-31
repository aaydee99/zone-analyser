'use client';

import { useEffect } from 'react';
import './globals.css';

/** The console's own layout failed: a plain page (it replaces the root layout), never a blank one. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center px-4">
        <main className="max-w-md text-center">
          <p className="text-xs font-semibold tracking-[0.2em] text-faint uppercase">Error</p>
          <h1 className="mt-2 text-2xl font-semibold text-ink">The console could not load</h1>
          <p className="mt-2 text-sm text-muted">Something went wrong on our side.{error.digest ? ` Reference: ${error.digest}.` : ''}</p>
          <div className="mt-6 flex justify-center gap-2">
            <button type="button" onClick={reset} className="inline-flex h-9 items-center rounded-[10px] btn-gold px-4 text-sm font-semibold">Try again</button>
            {/* A full page load: the router itself may be what failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="inline-flex h-9 items-center rounded-[10px] px-4 text-sm font-medium text-ink-2 hover:bg-raised">Back to the console</a>
          </div>
        </main>
      </body>
    </html>
  );
}
