import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Shell } from '@/components/shell';
import { SESSION_COOKIE } from '@/lib/http';
import { getMe, type Me } from '@/lib/auth';
import { isConfigured } from '@/lib/supabase';
import { PERMISSIONS } from '@/lib/rbac';
import { activeRunId } from '@/lib/runner';
import { activeRestore } from '@/lib/job-lock';
import { pendingFor } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  if (!isConfigured()) redirect('/setup');
  let me: Me | null;
  try {
    me = await getMe((await cookies()).get(SESSION_COOKIE)?.value);
  } catch {
    // Supabase reachable but schema missing, or unreachable: the setup page explains which.
    redirect('/setup');
  }
  if (!me) redirect('/login');
  const initial = {
    user: { id: me.id, email: me.email, name: me.name, role: me.role },
    permissions: [...PERMISSIONS[me.role]],
    expiresAt: me.expiresAt,
    activeRunId: activeRunId(),
    activeRestore: activeRestore(),
    pendingApprovals: pendingFor(me),
  };
  return <Shell initial={initial}>{children}</Shell>;
}
