'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { Alert, Button, PageHeader } from '@/components/ui';

/** Any console page that crashes while showing: the navigation stays, with a way to try again. */
export default function ConsoleError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <div>
      <PageHeader title="Something went wrong" />
      <Alert tone="bad" title="This page could not be shown">
        <p>{error.message || 'An unexpected error happened while showing this page.'}</p>
        {error.digest && <p className="mt-2 text-xs">Reference: {error.digest} (the server log has the details)</p>}
      </Alert>
      <div className="mt-4 flex gap-2">
        <Button onClick={reset} icon={<RefreshCw className="size-4" />}>Try again</Button>
        <Link href="/" className="inline-flex h-9 items-center rounded-[10px] px-4 text-sm font-medium text-ink-2 hover:bg-raised hover:text-ink">Back to the overview</Link>
      </div>
    </div>
  );
}
