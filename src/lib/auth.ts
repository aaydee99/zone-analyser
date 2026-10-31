import 'server-only';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { db, isConfigured, must, NotConfiguredError, timedFetch } from './supabase';
import { cachedSettings, getSettings } from './settings';
import { audit } from './audit';
import { isRole, type Role } from './rbac';

// Supabase Auth verifies email + password. The console then issues its own
// opaque session (only its SHA-256 is stored in `sessions`) so roles, disabled
// accounts and idle timeouts take effect immediately, without JWT refresh logic.

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** SHA-256 of the session cookie; also keys the vault unlock state. */
  sessionHash: string;
  /** When the session ends if idle from now on. */
  expiresAt: number;
}

export const MIN_PASSWORD = 12;
const SESSION_MAX_MS = 12 * 3600_000;
const PROFILE_TTL_MS = 30_000;
const DB_TOUCH_MS = 60_000;

export class AuthError extends Error {
  constructor(message: string, public status = 401) { super(message); }
}

interface Cached {
  me: Omit<Me, 'expiresAt'>;
  lastSeen: number;
  absoluteExpiry: number;
  profileAt: number;
  dbTouchedAt: number;
}

interface State {
  sessions: Map<string, Cached>;
  failures: Map<string, { count: number; blockedUntil: number }>;
  /** Timestamps of failed sign-ins across all accounts (global limiter). */
  recentFailures: number[];
  onEnd: Set<(sessionHash: string) => void>;
}
const g = globalThis as unknown as { __cfAuthState?: State };
const state: State = (g.__cfAuthState ??= { sessions: new Map(), failures: new Map(), recentFailures: [], onEnd: new Set() });
state.recentFailures ??= [];

/** Lets the vault drop its unlock state when a session ends. */
export function onSessionEnd(fn: (sessionHash: string) => void) { state.onEnd.add(fn); }

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function checkPassword(pw: unknown, label = 'Password'): asserts pw is string {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw new AuthError(`${label} must be at least ${MIN_PASSWORD} characters`, 400);
  if (pw.length > 256) throw new AuthError(`${label} is too long`, 400);
}

// Supabase Auth messages for these codes describe the user's own input; anything
// else (database or server faults) is logged and replaced with `fallback`.
const USER_FACING_AUTH_CODES = new Set(['weak_password', 'same_password', 'email_exists', 'user_already_exists', 'email_address_invalid']);
export function authApiMessage(error: { message?: string; code?: string } | null | undefined, fallback: string): string {
  if (error?.code && USER_FACING_AUTH_CODES.has(error.code) && error.message) return error.message;
  console.error(`[auth] ${fallback}:`, error);
  return fallback;
}

const normEmail = (e: unknown) => (typeof e === 'string' ? e.trim().toLowerCase() : '');

/** Fresh client per call: a sign-in stores its session on the client, which must never be shared between users. */
function anonClient() {
  if (!isConfigured()) throw new NotConfiguredError();
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: timedFetch },
  });
}

/** Verifies an email/password pair with Supabase Auth without keeping the Supabase session. */
export async function verifyPassword(email: string, password: string): Promise<string | null> {
  const c = anonClient();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data.user) return null;
  await c.auth.signOut({ scope: 'local' }).catch(() => {});
  return data.user.id;
}

/** Accounts whose password is being checked right now (see login()). */
const signingIn = new Set<string>();

function throttle(key: string) {
  const f = state.failures.get(key);
  const wait = f ? f.blockedUntil - Date.now() : 0;
  if (wait > 0) throw new AuthError(`Too many attempts — try again in ${Math.ceil(wait / 1000)}s`, 429);
}
function fail(key: string) {
  const f = state.failures.get(key) ?? { count: 0, blockedUntil: 0 };
  f.count++;
  // Back-off after the 3rd consecutive miss: 2s, 4s, 8s, 16s, then 30s. Capped low so
  // nobody can keep a real user locked out; the global limiter below handles volume.
  if (f.count >= 3) f.blockedUntil = Date.now() + Math.min(30_000, 1000 * 2 ** (f.count - 2));
  state.failures.set(key, f);
  state.recentFailures.push(Date.now());
}

// Password spraying (one guess per account across many accounts) never trips the
// per-email back-off, so failures are also counted across all accounts: above the
// threshold every sign-in attempt is slowed down, without locking anyone out.
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_THRESHOLD = 20;
async function globalSlowdown() {
  const cutoff = Date.now() - GLOBAL_WINDOW_MS;
  while (state.recentFailures.length && state.recentFailures[0] < cutoff) state.recentFailures.shift();
  const over = state.recentFailures.length - GLOBAL_THRESHOLD;
  if (over > 0) await new Promise((r) => setTimeout(r, Math.min(5000, 250 * over)));
}

interface ProfileRow { id: string; email: string; display_name: string; role: string; disabled: boolean }

async function loadProfile(id: string): Promise<ProfileRow | null> {
  return must(await db().from('profiles').select('id, email, display_name, role, disabled').eq('id', id).maybeSingle(), 'Reading profile') as ProfileRow | null;
}

// ── Setup ───────────────────────────────────────────────────────────────────

export class SchemaError extends Error {}

/** Throws SchemaError (full detail is logged, not returned) when a migration has not been applied. */
export async function needsSetup(): Promise<boolean> {
  const [profiles, claim] = await Promise.all([
    db().from('profiles').select('id', { count: 'exact', head: true }),
    db().from('setup_claim').select('id', { count: 'exact', head: true }),
  ]);
  const err = profiles.error ?? claim.error;
  if (err) {
    console.error('[setup] schema check failed:', err.message);
    throw new SchemaError('The database schema is missing or out of date — apply every file in supabase/migrations');
  }
  return (profiles.count ?? 0) === 0;
}

/**
 * Creates the first account, as super admin. Only allowed while there are no users at all.
 * The single-row setup_claim insert makes this atomic: of two concurrent requests, only
 * the one whose insert succeeds continues.
 */
export async function createFirstSuperAdmin(input: { email: string; password: string; name?: string }) {
  if (!(await needsSetup())) throw new AuthError('Setup is already complete', 409);
  const email = normEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError('Enter a valid email address', 400);
  checkPassword(input.password);
  const claim = await db().from('setup_claim').insert({ id: 1, email });
  if (claim.error) {
    if (claim.error.code === '23505') throw new AuthError('Setup is already complete', 409);
    throw new Error(`Claiming setup failed: ${claim.error.message}`);
  }
  const release = () => db().from('setup_claim').delete().eq('id', 1).then(() => {}, () => {});
  const { data, error } = await db().auth.admin.createUser({ email, password: input.password, email_confirm: true });
  if (error || !data.user) {
    await release();
    throw new AuthError(authApiMessage(error, 'Could not create the account'), 400);
  }
  const { error: pErr } = await db().from('profiles').insert({ id: data.user.id, email, display_name: (input.name ?? '').trim().slice(0, 80), role: 'super_admin' });
  if (pErr) {
    await db().auth.admin.deleteUser(data.user.id).catch(() => {});
    await release();
    throw new Error(`Could not create the profile: ${pErr.message}`);
  }
  await audit({ id: data.user.id, email }, 'setup.super_admin_created', email);
}

// ── Sessions ────────────────────────────────────────────────────────────────

export async function login(emailIn: string, password: string, userAgent?: string | null): Promise<string> {
  const email = normEmail(emailIn);
  if (!email || typeof password !== 'string' || !password) throw new AuthError('Enter your email and password', 400);
  const key = `login:${email}`;
  throttle(key);
  // One password check per account at a time: otherwise many parallel guesses all pass the
  // throttle before the first failure is counted.
  if (signingIn.has(key)) throw new AuthError('A sign-in for this account is already being checked — try again in a moment', 429);
  signingIn.add(key);
  let userId: string | null;
  try {
    await globalSlowdown();
    userId = await verifyPassword(email, password);
    if (!userId) fail(key);
  } finally {
    signingIn.delete(key);
  }
  if (!userId) {
    await audit({ id: null, email }, 'auth.login_failed', email);
    throw new AuthError('Incorrect email or password');
  }
  const profile = await loadProfile(userId);
  if (!profile) {
    await audit({ id: null, email }, 'auth.login_denied', email, { reason: 'no console profile' });
    throw new AuthError('This account has no access to the console — ask an admin to add you', 403);
  }
  if (profile.disabled) {
    await audit({ id: userId, email }, 'auth.login_denied', email, { reason: 'disabled' });
    throw new AuthError('This account is disabled', 403);
  }
  state.failures.delete(key);

  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  must(await db().from('sessions').insert({
    token_hash: hashToken(token), user_id: userId, expires_at: new Date(now + SESSION_MAX_MS).toISOString(),
    user_agent: userAgent?.slice(0, 300) ?? null,
  }), 'Creating session');
  await db().from('profiles').update({ last_login_at: new Date(now).toISOString() }).eq('id', userId);
  // Sessions past their absolute expiry are never valid again: drop them (any user's).
  await db().from('sessions').delete().lt('expires_at', new Date(now).toISOString()).then(() => {}, () => {});
  await audit({ id: userId, email }, 'auth.login', email);
  return token;
}

function endLocal(hash: string) {
  state.sessions.delete(hash);
  for (const fn of state.onEnd) fn(hash);
}

export async function logout(token: string | undefined) {
  if (!token) return;
  const hash = hashToken(token);
  endLocal(hash);
  await db().from('sessions').delete().eq('token_hash', hash);
}

/** Signs a user out everywhere (role change, disable, delete, password reset). */
export async function revokeUserSessions(userId: string, exceptHash?: string) {
  for (const [hash, c] of state.sessions) if (c.me.id === userId && hash !== exceptHash) endLocal(hash);
  let q = db().from('sessions').delete().eq('user_id', userId);
  if (exceptHash) q = q.neq('token_hash', exceptHash);
  await q;
}

/** Forces the next request of this user's sessions to re-read their profile (role changes apply at once). */
export function invalidateUser(userId: string) {
  for (const c of state.sessions.values()) if (c.me.id === userId) c.profileAt = 0;
}

/**
 * Resolves the signed-in user for a session cookie. `touch` refreshes the idle
 * timer — background polls pass false so an unattended tab still times out.
 */
export async function getMe(token: string | undefined, touch = true): Promise<Me | null> {
  if (!token) return null;
  const hash = hashToken(token);
  const now = Date.now();
  let c = state.sessions.get(hash);
  const stale = !c || now - c.profileAt > PROFILE_TTL_MS;
  // The settings and the session, read at the same time.
  const [settings, read] = await Promise.all([
    getSettings(),
    stale ? db().from('sessions').select('user_id, last_seen_at, expires_at').eq('token_hash', hash).maybeSingle() : null,
  ]);
  const idleMs = settings.sessionIdleMinutes * 60_000;

  if (stale) {
    const row = must(read!, 'Reading session') as { user_id: string; last_seen_at: string; expires_at: string } | null;
    if (!row) { if (c) endLocal(hash); return null; }
    const profile = await loadProfile(row.user_id);
    if (!profile || profile.disabled || !isRole(profile.role)) { await logout(token); return null; }
    const lastSeen = Math.max(c?.lastSeen ?? 0, Date.parse(row.last_seen_at));
    c = {
      me: { id: profile.id, email: profile.email, name: profile.display_name, role: profile.role, sessionHash: hash },
      lastSeen, absoluteExpiry: Date.parse(row.expires_at), profileAt: now, dbTouchedAt: c?.dbTouchedAt ?? lastSeen,
    };
    state.sessions.set(hash, c);
  }
  if (!c) return null;

  if (now > c.absoluteExpiry || now - c.lastSeen > idleMs) { await logout(token); return null; }
  if (touch) {
    c.lastSeen = now;
    if (now - c.dbTouchedAt > DB_TOUCH_MS) {
      c.dbTouchedAt = now;
      // Not waited for: nothing in this request depends on it.
      void db().from('sessions').update({ last_seen_at: new Date(now).toISOString() }).eq('token_hash', hash).then(() => {}, () => {});
    }
  }
  return { ...c.me, expiresAt: Math.min(c.absoluteExpiry, c.lastSeen + idleMs) };
}

/** Synchronous idle check used by long-lived streams. */
export function sessionStillValid(hash: string) {
  const c = state.sessions.get(hash);
  return !!c && Date.now() <= c.absoluteExpiry && Date.now() - c.lastSeen <= cachedSettings().sessionIdleMinutes * 60_000;
}

export async function changeOwnPassword(me: Me, current: string, next: string) {
  const key = `pw:${me.id}`;
  throttle(key);
  if (!(await verifyPassword(me.email, current))) { fail(key); throw new AuthError('Current password is incorrect'); }
  state.failures.delete(key);
  checkPassword(next, 'New password');
  if (next === current) throw new AuthError('Choose a different password', 400);
  const { error } = await db().auth.admin.updateUserById(me.id, { password: next });
  if (error) throw new AuthError(authApiMessage(error, 'Could not change the password'), 400);
  await revokeUserSessions(me.id, me.sessionHash);
  await audit(me, 'auth.password_changed', me.email);
}
