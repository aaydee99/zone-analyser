import { NextResponse } from 'next/server';
import { clientKey, HttpError, publicRoute, readBody, setSessionCookie } from '@/lib/http';
import { captchaSiteKey, requireCaptcha } from '@/lib/captcha';
import { createFirstSuperAdmin, login, needsSetup, SchemaError } from '@/lib/auth';
import { isConfigured, missingEnv, publicSignupEnabled } from '@/lib/supabase';
import { checkSetupToken, clearSetupToken, setupToken } from '@/lib/setup-token';

export const dynamic = 'force-dynamic';

/**
 * First-run state. Once setup is complete this reveals nothing beyond that fact;
 * before it, it lists missing variables and whether the schema is in place.
 */
export const GET = publicRoute(async () => {
  const captcha = captchaSiteKey();
  if (!isConfigured()) return { configured: false, missing: missingEnv(), needsSetup: true, schemaError: null, captchaSiteKey: captcha };
  let pending: boolean;
  try {
    pending = await needsSetup();
  } catch (err) {
    const msg = err instanceof SchemaError ? err.message : 'Cannot reach Supabase — check SUPABASE_URL and the keys';
    if (!(err instanceof SchemaError)) console.error('[setup] Supabase check failed:', err);
    return { configured: true, missing: [], needsSetup: true, schemaError: msg, captchaSiteKey: captcha };
  }
  if (!pending) return { configured: true, missing: [], needsSetup: false, schemaError: null, captchaSiteKey: captcha };
  setupToken(); // printed to the server console the first time
  return { configured: true, missing: [], needsSetup: true, schemaError: null, signupEnabled: await publicSignupEnabled(), captchaSiteKey: captcha };
});

/** Creates the first super admin and signs them in. Needs the one-time setup token; refused once any user exists. */
export const POST = publicRoute(async (req) => {
  if (!isConfigured()) throw new HttpError(503, `Set ${missingEnv().join(', ')} in .env.local first`);
  const { email, password, name, setupToken: token, captcha } = await readBody<{ email: string; password: string; name?: string; setupToken?: string; captcha?: string }>(req);
  await requireCaptcha(captcha, clientKey(req));
  try {
    if (!(await needsSetup())) throw new HttpError(409, 'Setup is already complete');
  } catch (err) {
    if (err instanceof SchemaError) throw new HttpError(503, err.message);
    throw err;
  }
  if (!checkSetupToken(token)) throw new HttpError(403, 'Setup token is missing or wrong — copy it from the terminal running the console');
  await createFirstSuperAdmin({ email, password, name });
  clearSetupToken();
  return setSessionCookie(NextResponse.json({ ok: true }), await login(email, password, req.headers.get('user-agent')));
});
