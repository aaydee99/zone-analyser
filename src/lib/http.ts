import 'server-only';
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { AuthError, getMe, type Me } from './auth';
import { VaultError } from './vault';
import { NotConfiguredError } from './supabase';
import { can, type Permission } from './rbac';
import { isAllowedHost } from './hosts';
import { audit } from './audit';
import { RelayError, relay, relayed, relayedMe } from './worker-link';

export const SESSION_COOKIE = 'cfbc_session';
const SESSION_MAX_AGE = 12 * 3600;

export class HttpError extends Error {
  constructor(public status: number, message: string, public headers?: Record<string, string>) { super(message); }
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Sliding windows per key (a user, or a client address for public routes), in memory.

const g = globalThis as unknown as { __rateLimit?: Map<string, number[]> };
const hits = (g.__rateLimit ??= new Map<string, number[]>());

/** RATE_LIMIT_SCALE multiplies the general limits (automated tests raise it; 1 by default). */
const SCALE = Math.max(1, Number(process.env.RATE_LIMIT_SCALE) || 1);

/** Throws 429 (with Retry-After) once `key` has made `max` requests within `windowMs`. */
export function rateLimit(key: string, max: number, windowMs = 60_000) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  if (list.length >= max) {
    const retry = Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000));
    hits.set(key, list);
    throw new HttpError(429, `Too many requests — try again in ${retry}s`, { 'Retry-After': String(retry) });
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => t > now - 3_600_000)) hits.delete(k);
}

/** Per signed-in user: all requests, and requests that change something. */
const LIMIT_ALL = 600;
const LIMIT_WRITE = 60;
/** Per client address on routes reachable without a session (sign-in, setup). */
const LIMIT_PUBLIC = 30;

/**
 * The client's address for rate limits. The console listens on 127.0.0.1 behind its TLS proxy,
 * and proxies append the address they saw, so only the LAST X-Forwarded-For hop is trustworthy —
 * earlier ones are whatever the client sent. CONSOLE_CLIENT_IP_HEADER names a header to use
 * instead (e.g. cf-connecting-ip when Cloudflare is the only way in).
 */
export function clientKey(req: Request) {
  const named = process.env.CONSOLE_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (named) return req.headers.get(named)?.trim() || 'direct';
  return req.headers.get('x-forwarded-for')?.split(',').map((x) => x.trim()).filter(Boolean).pop() || 'direct';
}

export async function sessionToken() {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/**
 * Every API request: the Host header must be one the console serves (blocks DNS
 * rebinding, where an attacker's domain is re-pointed at 127.0.0.1). Mutating
 * requests must also carry an Origin for that same allowed host.
 */
function checkRequest(req: Request) {
  const host = req.headers.get('host');
  if (!isAllowedHost(host)) throw new HttpError(403, 'Host not allowed');
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.get('origin');
  let originHost: string | null = null;
  try { originHost = origin ? new URL(origin).host : null; } catch { /* "null" or malformed */ }
  if (!originHost || originHost !== host || !isAllowedHost(originHost)) throw new HttpError(403, 'Cross-origin request refused');
}

/** Largest JSON body any route accepts. */
const MAX_BODY = 1024 * 1024;

export async function readBody<T>(req: Request): Promise<T> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) throw new HttpError(413, 'Request is too large');
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? 'application/json')) throw new HttpError(415, 'Request body must be JSON');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Request is too large');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
}

export function requirePerm(me: Me, perm: Permission) {
  if (!can(me.role, perm)) throw new HttpError(403, 'Your role does not allow this');
}

/**
 * Errors the console raises on purpose carry a user-facing message. Anything else
 * (database errors, bugs) is logged with a reference and answered generically so
 * internal details never reach the client.
 */
function errorResponse(err: unknown) {
  if (err instanceof HttpError || err instanceof VaultError || err instanceof AuthError || err instanceof NotConfiguredError || err instanceof RelayError) {
    if (err.status >= 500) console.error(err);
    return NextResponse.json({ error: err.message }, { status: err.status, headers: err instanceof HttpError ? err.headers : undefined });
  }
  const ref = crypto.randomBytes(4).toString('hex');
  console.error(`[error ${ref}]`, err);
  return NextResponse.json({ error: `Something went wrong on the server (ref ${ref}) — see the console log` }, { status: 500 });
}

/**
 * Refused attempts (a role without the permission, a rate limit) go to the audit log as security
 * events — at most once a minute per user, kind and route, so a flood cannot fill the log.
 */
const lastLogged = new Map<string, number>();
async function logRefusal(me: Me, err: unknown, req: Request) {
  const status = err instanceof HttpError || err instanceof VaultError || err instanceof AuthError || err instanceof RelayError ? err.status : 0;
  if (status !== 403 && status !== 429) return;
  const reason = (err as Error).message;
  const kind = status === 429 ? 'security.rate_limited' : 'security.denied';
  const key = `${me.id}:${kind}:${new URL(req.url).pathname}`;
  if ((lastLogged.get(key) ?? 0) > Date.now() - 60_000) return;
  lastLogged.set(key, Date.now());
  await audit(me, kind, new URL(req.url).pathname, { method: req.method, reason });
}

const toResponse = (res: unknown) => (res instanceof Response ? res : NextResponse.json(res ?? { ok: true }));

type Handler<C> = (req: Request, ctx: C, me: Me) => Promise<Response | unknown>;

/**
 * Wraps a signed-in route: origin check, session, rate limits, permission, JSON errors.
 * `?peek=1` on a GET checks the session without counting as activity. `limit` adds a tighter
 * per-user limit for a sensitive route (revealing secrets, testing keys, applying …).
 */
export function route<C = unknown>(fn: Handler<C>, opts: { perm?: Permission; limit?: { name: string; max: number; windowMs?: number } } = {}) {
  return async (req: Request, ctx: C) => {
    let who: Me | null = null;
    try {
      checkRequest(req);
      // On a worker: a request the worker loop replays for the web side, already checked there.
      const fromWeb = await relayedMe(req);
      const peek = req.method === 'GET' && new URL(req.url).searchParams.get('peek') === '1';
      const me = fromWeb ?? await getMe(await sessionToken(), !peek);
      if (!me) throw new HttpError(401, 'Your session has ended — sign in again');
      who = me;
      if (!fromWeb) {
        rateLimit(`user:${me.id}`, LIMIT_ALL * SCALE);
        if (req.method !== 'GET' && req.method !== 'HEAD') rateLimit(`user:${me.id}:write`, LIMIT_WRITE * SCALE);
      }
      if (opts.perm) requirePerm(me, opts.perm);
      if (opts.limit && !fromWeb) rateLimit(`user:${me.id}:${opts.limit.name}`, opts.limit.max, opts.limit.windowMs);
      // On Vercel (web role): the worker runs it, from its own server and IP.
      if (!fromWeb && relayed(req)) return await relay(req, me);
      return toResponse(await fn(req, ctx, me));
    } catch (err) {
      if (who) await logRefusal(who, err, req);
      return errorResponse(err);
    }
  };
}

/** Routes reachable without a session (sign-in, first-run setup). */
export function publicRoute<C = unknown>(fn: (req: Request, ctx: C) => Promise<Response | unknown>) {
  return async (req: Request, ctx: C) => {
    try {
      checkRequest(req);
      rateLimit(`ip:${clientKey(req)}`, LIMIT_PUBLIC * SCALE);
      return toResponse(await fn(req, ctx));
    } catch (err) {
      return errorResponse(err);
    }
  };
}

// Always Secure: browsers accept Secure cookies on http://localhost and 127.0.0.1
// (they count as secure contexts), and every other host is HTTPS-only (src/proxy.ts).
const COOKIE_ATTRS = { httpOnly: true, sameSite: 'strict', path: '/', secure: true } as const;

/** Issues a session cookie. Login always mints a new token, so a session ID is never reused across sign-ins. */
export function setSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(SESSION_COOKIE, token, { ...COOKIE_ATTRS, maxAge: SESSION_MAX_AGE });
  return res;
}

/** Expires the session cookie with the same attributes it was set with. */
export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, '', { ...COOKIE_ATTRS, maxAge: 0 });
  return res;
}
