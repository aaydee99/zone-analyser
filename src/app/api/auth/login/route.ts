import { NextResponse } from 'next/server';
import { clientKey, publicRoute, readBody, sessionToken, setSessionCookie } from '@/lib/http';
import { requireCaptcha } from '@/lib/captcha';
import { login, logout } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const POST = publicRoute(async (req) => {
  const { email, password, captcha } = await readBody<{ email: string; password: string; captcha?: string }>(req);
  await requireCaptcha(captcha, clientKey(req));
  const token = await login(email, password, req.headers.get('user-agent'));
  // A fresh session ID on every sign-in; any session this browser already had is destroyed.
  await logout(await sessionToken());
  return setSessionCookie(NextResponse.json({ ok: true }), token);
});
