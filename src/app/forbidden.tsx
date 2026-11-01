import Link from 'next/link';

/** A page this role may not open, outside the console layout. */
export default function Forbidden() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <p className="text-xs font-semibold tracking-[0.2em] text-faint uppercase">403</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink">You don’t have access to this page</h1>
        <p className="mt-2 text-sm text-muted">Your role cannot open it. An admin can change your role on the Users page.</p>
        <Link href="/console" className="mt-6 inline-flex h-9 items-center rounded-[10px] btn-gold px-4 text-sm font-semibold">
          Back to the console
        </Link>
      </div>
    </main>
  );
}
