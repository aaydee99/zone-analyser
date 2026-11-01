import Link from 'next/link';
import { Lock } from 'lucide-react';
import { Alert, PageHeader } from '@/components/ui';

/** A console page this role may not open (403): the navigation stays, with a way back. */
export default function ConsoleForbidden() {
  return (
    <div>
      <PageHeader eyebrow="403" title="You don’t have access to this page" />
      <Alert tone="info" title="Not available for your role">
        <span className="inline-flex items-center gap-1.5"><Lock className="size-3.5" aria-hidden />Your role cannot open this page. An admin can change your role on the Users page.</span>
      </Alert>
      <div className="mt-4">
        <Link href="/console" className="inline-flex h-9 items-center rounded-[10px] px-4 text-sm font-medium text-ink-2 hover:bg-raised hover:text-ink">Back to the overview</Link>
      </div>
    </div>
  );
}
