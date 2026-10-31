'use client';

import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { Alert, Button, PageHeader } from '@/components/ui';

/** The traffic page failed while showing what it read: say what happened instead of a blank page. */
export default function TrafficError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <div>
      <PageHeader eyebrow="Cloudflare" title="Traffic analytics" />
      <Alert tone="bad" title="The traffic page could not show this">
        <p>{error.message || 'Something went wrong while showing the traffic.'}</p>
        <p className="mt-2 text-xs">If the console was just updated, the worker may still run the previous version: it restarts once it is idle, or cancel its run in GitHub › Actions › Console worker.</p>
      </Alert>
      <div className="mt-4"><Button onClick={reset} icon={<RefreshCw className="size-4" />}>Try again</Button></div>
    </div>
  );
}
