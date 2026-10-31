import { notFound } from 'next/navigation';
import { requirePage } from '@/lib/page-guard';
import { CHECK, isCheckId } from '@/lib/monitor-types';

export const dynamic = 'force-dynamic';

/** A check the user may not see (Tokens & members is for admins) is a 404, not an empty page. */
export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ check: string }> }) {
  const { check } = await params;
  if (!isCheckId(check)) notFound();
  await requirePage(CHECK[check].perm);
  return children;
}
