import { requirePage } from '@/lib/page-guard';
import { CompareTabs } from './parts';

export const dynamic = 'force-dynamic';

export default async function Layout({ children }: { children: React.ReactNode }) {
  await requirePage('runs:read');
  return (
    <div>
      <CompareTabs />
      {children}
    </div>
  );
}
