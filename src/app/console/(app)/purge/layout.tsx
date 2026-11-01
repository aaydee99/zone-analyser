import { pageAllows } from '@/lib/page-guard';
import { LockedPage } from '@/components/locked-page';

export const dynamic = 'force-dynamic';

export default async function Layout({ children }: { children: React.ReactNode }) {
  if (await pageAllows('cloudflare:act')) return children;
  return <LockedPage eyebrow="Cloudflare" title="Cache purge" description="Purge cached files from a zone, by URL, host, tag, prefix or everything." who="Admins ask for a purge and a super admin approves it." />;
}
