import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpError } from './http';

// Cloudflare credentials typed in at run time, for the changes that must not use a stored token
// (Logpush job management, cache purges). Either an API token or a Global API Key with its email. Held only in
// memory for the one request that carries it: never stored, returned, logged or audited, and the
// reference is dropped once the change has run. The calls go straight to the Cloudflare API with it
// (a handful per change, like the activity revert), not through the stored tokens' budget.

const CF_API = 'https://api.cloudflare.com/client/v4';
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const GLOBAL_KEY_RE = /^[0-9A-Za-z]{30,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{30,200}$/;

export type RuntimeCredential = { kind: 'token'; token: string } | { kind: 'global'; email: string; apiKey: string };

export const NEED_CREDENTIAL = 'Enter an API token with Logs Edit, or a Global API Key and its email — they are used for this change only and never stored';
export const NEED_PURGE_CREDENTIAL = 'Enter an API token with Zone › Cache Purge › Purge, or a Global API Key and its email — they are used for this purge only and never stored';

/** The credential in a request body (`{ kind: 'token', token }` or `{ kind: 'global', email, apiKey }`), or null when none was sent. */
export function parseRuntimeCredential(raw: unknown): RuntimeCredential | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (c.kind === 'token') {
    const token = typeof c.token === 'string' ? c.token.trim() : '';
    if (!TOKEN_RE.test(token)) throw new HttpError(400, 'That does not look like a Cloudflare API token');
    return { kind: 'token', token };
  }
  if (c.kind === 'global') {
    const email = typeof c.email === 'string' ? c.email.trim() : '';
    const apiKey = typeof c.apiKey === 'string' ? c.apiKey.trim() : '';
    if (!EMAIL_RE.test(email) || !GLOBAL_KEY_RE.test(apiKey)) throw new HttpError(400, 'Enter the Cloudflare account email and its Global API Key');
    return { kind: 'global', email, apiKey };
  }
  return null;
}

const store = new AsyncLocalStorage<{ cred: RuntimeCredential | null }>();

/** Runs `fn` with `cred` available to runtimeCredential(); the reference is dropped afterwards. */
export async function withRuntimeCredential<T>(cred: RuntimeCredential | null, fn: () => Promise<T>): Promise<T> {
  const box = { cred };
  try { return await store.run(box, fn); } finally { box.cred = null; }
}

/** The credential of the request being run; a 409 (an approval stays pending) when there is none. */
export function runtimeCredential(need = NEED_CREDENTIAL): RuntimeCredential {
  const c = store.getStore()?.cred;
  if (!c) throw new HttpError(409, need);
  return c;
}

export const authKind = (c: RuntimeCredential) => (c.kind === 'token' ? 'api_token' : 'global_api_key');

export interface RuntimeAnswer<T = unknown> { status: number; body: { success?: boolean; errors?: { code?: number; message?: string }[]; result?: T } | null }

/** One call with the typed-in credential. Never throws for Cloudflare's answers; 502 when it cannot be reached. */
export async function cfRuntime<T = unknown>(cred: RuntimeCredential, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<RuntimeAnswer<T>> {
  const auth: Record<string, string> = cred.kind === 'token' ? { Authorization: `Bearer ${cred.token}` } : { 'X-Auth-Email': cred.email, 'X-Auth-Key': cred.apiKey };
  let res: Response;
  try {
    res = await fetch(`${CF_API}${path}`, {
      method, cache: 'no-store', signal: AbortSignal.timeout(30_000),
      headers: { ...auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new HttpError(502, 'Could not reach the Cloudflare API');
  }
  const parsed = (await res.json().catch(() => null)) as RuntimeAnswer<T>['body'];
  return { status: res.status, body: parsed };
}

/** Cloudflare did not accept the credential, or it lacks the permission (codes 9103/9106/9109/10000 or 401/403). */
export const credentialRefused = (r: RuntimeAnswer) => r.status === 401 || r.status === 403 || !!r.body?.errors?.some((e) => [9103, 9106, 9109, 10000, 10001].includes(Number(e.code)));
