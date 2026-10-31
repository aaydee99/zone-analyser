import { Loading, Skeleton, SkeletonStats, SkeletonTable } from '@/components/ui';

// Shown at once while a console page loads (inside the shell, which stays in place). Each section
// has its own loading.tsx using this, inside its layout: a loading boundary above a layout that checks
// permissions would start the response (200) before that check could answer 404.
export function PageLoading() {
  return (
    <Loading label="Loading the page" className="space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-3 w-full max-w-xl" />
      </div>
      <SkeletonStats count={4} />
      <SkeletonTable rows={7} cols={5} />
    </Loading>
  );
}
