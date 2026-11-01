import { pageAllows } from '@/lib/page-guard';
import { LockedPage } from '@/components/locked-page';

export const dynamic = 'force-dynamic';

export default async function Layout({ children }: { children: React.ReactNode }) {
  if (await pageAllows('cloudflare:query')) return children;
  return <LockedPage eyebrow="Tools" title="API console" description="Send read-only requests to the Cloudflare API with the stored tokens." who="Admins and super admins can use it." />;
}
