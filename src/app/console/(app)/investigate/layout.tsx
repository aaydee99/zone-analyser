import { requirePage } from '@/lib/page-guard';
import { InvestigateTabs } from './tabs';

export const dynamic = 'force-dynamic';

export default async function Layout({ children }: { children: React.ReactNode }) {
  await requirePage('runs:read');
  return (
    <div>
      <InvestigateTabs />
      {children}
    </div>
  );
}
