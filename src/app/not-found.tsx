import Link from 'next/link';

/** Any address the console does not have: say so, with a way back. */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <p className="text-xs font-semibold tracking-[0.2em] text-faint uppercase">404</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink">This page does not exist</h1>
        <p className="mt-2 text-sm text-muted">The address may be mistyped, or the page was moved.</p>
        <Link href="/" className="mt-6 inline-flex h-9 items-center rounded-[10px] bg-signal px-4 text-sm font-semibold text-signal-ink hover:bg-signal-strong">
          Back to the console
        </Link>
      </div>
    </main>
  );
}
