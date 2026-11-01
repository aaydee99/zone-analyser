import 'server-only';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getMe } from './auth';
import { SESSION_COOKIE } from './http';
import { can, type Permission } from './rbac';

/**
 * Server-side guard for an admin page: someone without `perm` gets a 404 — the page is not
 * rendered or sent, so it is not merely hidden in the browser. (Its API routes check the same
 * permission themselves.)
 */
export async function requirePage(perm: Permission) {
  const me = await getMe((await cookies()).get(SESSION_COOKIE)?.value, false);
  if (!me) redirect('/console/login');
  if (!can(me.role, perm)) notFound();
}

/** For a page every role sees: signed in, and whether this user may use it (the layout shows a notice when not). */
export async function pageAllows(perm: Permission): Promise<boolean> {
  const me = await getMe((await cookies()).get(SESSION_COOKIE)?.value, false);
  if (!me) redirect('/console/login');
  return can(me.role, perm);
}
