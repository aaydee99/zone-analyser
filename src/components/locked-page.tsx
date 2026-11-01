import { Lock } from 'lucide-react';
import { Alert, PageHeader } from './ui';

/** What a role without the permission sees on a page every role can find: what it does, and who can use it. */
export function LockedPage({ eyebrow, title, description, who }: { eyebrow: string; title: string; description: string; who: string }) {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      <Alert tone="info" title="View only">
        <span className="inline-flex items-center gap-1.5"><Lock className="size-3.5" aria-hidden />Your role cannot use this page. {who}</span>
      </Alert>
    </div>
  );
}
