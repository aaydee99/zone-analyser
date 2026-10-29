import { NextResponse } from 'next/server';
import { clearSessionCookie, publicRoute, sessionToken } from '@/lib/http';
import { getMe, logout } from '@/lib/auth';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/** Deletes the session row, its in-memory state and vault unlock, then expires the cookie. */
export const POST = publicRoute(async () => {
  const token = await sessionToken();
  const me = await getMe(token, false).catch(() => null);
  await logout(token);
  if (me) await audit(me, 'auth.logout', me.email);
  return clearSessionCookie(NextResponse.json({ ok: true }));
});
