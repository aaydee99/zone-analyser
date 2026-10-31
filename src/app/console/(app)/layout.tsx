import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { Shell } from '@/components/shell';
import { SESSION_COOKIE } from '@/lib/http';
import { getMe, type Me } from '@/lib/auth';
import { isConfigured } from '@/lib/supabase';
import { PERMISSIONS } from '@/lib/rbac';
import { liveState } from '@/lib/live-state';

export const dynamic = 'force-dynamic';
/** How long a page waits for the live state before rendering without it. */
const LIVE_WAIT_MS = 400;

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  if (!isConfigured()) redirect('/console/setup');
  let me: Me | null;
  try {
    me = await getMe((await cookies()).get(SESSION_COOKIE)?.value);
  } catch {
    // Supabase reachable but schema missing, or unreachable: the setup page explains which.
    redirect('/console/setup');
  }
  if (!me) redirect('/console/login');
  // The running job, approvals and the worker come from the worker (on Vercel): the page does not wait
  // for them beyond a moment. Slower, it renders at once and the shell asks right after; the read (which
  // also starts a sleeping worker) still finishes in the background.
  const reading = liveState(me).catch(() => null);
  after(() => reading);
  const live = await Promise.race([reading, new Promise<null>((resolve) => setTimeout(() => resolve(null), LIVE_WAIT_MS))]);
  const initial = {
    user: { id: me.id, email: me.email, name: me.name, role: me.role },
    permissions: [...PERMISSIONS[me.role]],
    expiresAt: me.expiresAt,
    ...(live ?? { activeRunId: null, activeRestore: null, pendingApprovals: 0, stale: true }),
  };
  return <Shell initial={initial}>{children}</Shell>;
}
