import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// The browser never talks to Supabase: every query runs here with the
// service-role key, after the console has checked the caller's role.

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

export function missingEnv(): string[] {
  // The vault server key is kept in Supabase (public.vault_keys) and created on first use.
  return REQUIRED.filter((k) => !process.env[k]?.trim());
}

export const isConfigured = () => missingEnv().length === 0;

export class NotConfiguredError extends Error {
  status = 503;
  constructor() { super(`Supabase is not configured — set ${missingEnv().join(', ')} in .env.local`); }
}

const g = globalThis as unknown as { __cfDb?: SupabaseClient };
/** Every database call gives up after this long (Supabase hanging must not hang the console with it). */
const DB_TIMEOUT_MS = 30_000;
export const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(DB_TIMEOUT_MS)]) : AbortSignal.timeout(DB_TIMEOUT_MS) });
const OPTS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: timedFetch } };

/** Service-role client for all data access. (Sign-in checks use a fresh anon client per call — see auth.ts.) */
export function db(): SupabaseClient {
  if (!isConfigured()) throw new NotConfiguredError();
  return (g.__cfDb ??= createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, OPTS));
}

/**
 * Whether Supabase Auth still accepts public sign-ups (its default). The console
 * creates accounts only through the admin API, so sign-ups should be disabled.
 * Returns null when it cannot be determined.
 */
export async function publicSignupEnabled(): Promise<boolean | null> {
  if (!isConfigured()) return null;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL!.replace(/\/$/, '')}/auth/v1/settings`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY! }, signal: AbortSignal.timeout(5000), cache: 'no-store',
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { disable_signup?: boolean };
    return typeof j.disable_signup === 'boolean' ? !j.disable_signup : null;
  } catch {
    return null;
  }
}

/** Unwraps a Supabase result, turning its error into an exception. */
export function must<T>(res: { data: T; error: { message: string } | null }, what = 'Database request'): T {
  if (res.error) throw new Error(`${what} failed: ${res.error.message}`);
  return res.data;
}
