import { requirePage } from '@/lib/page-guard';

export const dynamic = 'force-dynamic';

export default async function Layout({ children }: { children: React.ReactNode }) {
  await requirePage('settings:read');
  return children;
}
