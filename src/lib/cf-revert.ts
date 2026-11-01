import 'server-only';
import crypto from 'node:crypto';
import { HttpError } from './http';
import { audit } from './audit';
import { uncache } from './cache';
import type { Me } from './auth';
import { can } from './rbac';
import { CF_API, actionOf, credentialForAccount, entryAt, historyFor, type RawEntry } from './cf-audit';
import { SECRET_KEY, isOnePath, stateAfter, targetName, unwrap } from './cf-classify';
import { activeRestore } from './job-lock';
import { activeRunId } from './runner';
import { db } from './supabase';

// Reverting one change from Cloudflare activity, through the same API endpoint the change used:
//   created → DELETE it            (POST <collection> → DELETE <collection>/<new id>)
//   updated → send the old values  (PATCH/PUT <resource> with the state before the change)
//   deleted → create it again      (DELETE <collection>/<id> → POST <collection> with its old state; it gets a new id)
// The state before a change comes from Cloudflare Resource History. The request is worked out with
// the stored read-only token and shown for review; it is sent with the Global API Key typed in for
// it, which is never stored. Applying works the request out again and refuses if it no longer
// matches what was reviewed.
//
// Cloudflare One (Zero Trust) changes decide who reaches internal applications, so only super admins
// revert them (cloudflare:revert_one). An Access application or policy, or a Gateway rule, is replaced
// whole by PUT, so its update is reverted with the whole earlier object; items added to or removed from
// a Gateway list (PATCH append/remove) are removed or added back. Secrets, sessions and enrolments are not.

export interface CfRevertPlan {
  accountId: string;
  entryId: string;
  zoneId: string;
  zoneName: string;
  /** What reverting does, in a sentence. */
  summary: string;
  method: 'DELETE' | 'POST' | 'PATCH' | 'PUT';
  path: string;
  body: unknown;
  /** Fields of the change that are not reverted (secrets the audit log does not keep). */
  skipped: string[];
  /** The resource changed again after this entry: reverting also undoes that. */
  changedSince: boolean;
  /** Anything else worth knowing before sending. */
  notes: string[];
  /** A Cloudflare One (Zero Trust) change: only super admins revert it. */
  cloudflareOne: boolean;
  /** Identifies this exact request; applying refuses a different one. */
  planHash: string;
}

const PATH_SEGMENT = /^[A-Za-z0-9_.:@-]{1,200}$/;
/** Changes the console does not undo: zones and accounts themselves, people and access, secrets and code. */
const BLOCKED: [RegExp, string][] = [
  [/^\/zones(\/[^/]+)?$/, 'Adding, removing or changing a zone itself is not reverted here'],
  [/^\/accounts\/[^/]+$/, 'Account settings are not reverted here'],
  [/\/(members|tokens|roles|subscriptions|billing|registrar)(\/|$)/, 'Members, API tokens, roles, billing and domain registration are not reverted here'],
  [/\/purge_cache$/, 'A cache purge cannot be undone'],
  [/\/workers\/scripts|\/pages\/projects\/[^/]+\/deployments/, 'The audit log does not keep Worker or Pages code, so a deploy cannot be reverted'],
  [/certificate|\/origin_tls_client_auth|\/keyless_certificates|\/mtls/, 'Certificates and keys are not in the audit log, so they cannot be put back'],
  // Cloudflare One
  [/\/access\/service_tokens/, 'Service tokens carry a client secret the audit log does not keep, so they are not reverted here'],
  [/\/access\/identity_providers/, 'Identity providers carry client secrets the audit log does not keep, so they are not reverted here'],
  [/\/access\/(keys|apps\/[^/]+\/ca)(\/|$)/, 'Access signing keys and short-lived certificates cannot be put back'],
  [/\/access\/(users|organizations\/revoke_user|logs)(\/|$)|\/revoke(_tokens)?$/, 'Revoking sessions or users cannot be undone'],
  [/\/cfd_tunnel\/[^/]+\/(token|connections|connectors)(\/|$)|\/warp_connector\/[^/]+\/token/, 'Tunnel tokens and connections cannot be reverted'],
  [/\/devices\/(revoke|unrevoke|registrations)(\/|$)|\/devices\/[0-9a-f-]{36}$/, 'Device enrolment and revocation are not reverted here'],
];
/** Set by Cloudflare, never sent. */
const READ_ONLY = new Set(['created_on', 'modified_on', 'created_at', 'updated_at', 'modified_at', 'last_updated', 'etag', 'meta']);
const READ_ONLY_TOP = new Set(['id', 'zone_id', 'zone_name', 'account_id', 'locked', 'proxiable', 'editable', 'version']);
const MASKED = /^\*{3,}$|redacted|•{3,}/i;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function refuse(msg: string): never { throw new HttpError(422, msg); }

/** Copy without fields Cloudflare sets itself (and, for a body to create from, without the ids). */
function clean(v: unknown, top: boolean): unknown {
  if (Array.isArray(v)) return v.map((x) => clean(x, false));
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (READ_ONLY.has(k) || (top && READ_ONLY_TOP.has(k))) continue;
    // Ruleset rules carry a read-only version.
    if (k === 'version' && 'expression' in v) continue;
    out[k] = clean(x, false);
  }
  return out;
}

/** Paths of secret-looking or masked values (they cannot be sent back). */
function secrets(v: unknown, p = '', out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => secrets(x, `${p}[${i}]`, out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) {
    const at = p ? `${p}.${k}` : k;
    if (SECRET_KEY.test(k) && x !== null && x !== '' && x !== undefined) out.push(at);
    else secrets(x, at, out);
  } else if (typeof v === 'string' && MASKED.test(v)) out.push(p || 'value');
  return out;
}

/** Stable JSON (sorted keys), for comparing states. */
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const pick = (v: unknown, keys: string[]) => (isObj(v) ? Object.fromEntries(keys.filter((k) => k in v).map((k) => [k, v[k]])) : {});

/** The API path of the change, checked to stay inside its own account or zone. */
function apiPath(e: RawEntry, accountId: string): string {
  const p = (e.raw?.uri ?? '').split('?')[0].replace(/^https?:\/\/[^/]+/, '').replace(/^\/client\/v4/, '');
  for (const [re, why] of BLOCKED) if (re.test(p)) refuse(why);
  const parts = p.split('/').slice(1);
  if (!p.startsWith('/') || parts.length < 2 || !parts.every((x) => PATH_SEGMENT.test(x) && x !== '..' && x !== '.')) refuse('This change has no API path that can be reverted');
  if (parts[0] === 'accounts' ? parts[1] !== accountId : parts[0] === 'zones' ? parts[1] !== e.zone?.id : true) refuse('This change is not inside one account or zone');
  return p;
}

/** GET with the stored (read-only) token: the resource now, null when it does not exist, undefined when it cannot be read. */
async function current(token: string, path: string): Promise<unknown | null | undefined> {
  try {
    const res = await fetch(`${CF_API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000), cache: 'no-store' });
    if (res.status === 404) return null;
    const body = (await res.json().catch(() => null)) as { success?: boolean; result?: unknown } | null;
    return res.ok && body?.success ? body.result : undefined;
  } catch {
    return undefined;
  }
}

const hash = (method: string, path: string, body: unknown) => crypto.createHash('sha256').update(stable({ method, path, body })).digest('hex').slice(0, 24);

/** Works out the request that reverts one audit-log entry, without sending anything. */
/** Only super admins revert a Cloudflare One change. */
export function mayRevert(me: Me, plan: CfRevertPlan) {
  if (plan.cloudflareOne && !can(me.role, 'cloudflare:revert_one')) throw new HttpError(403, 'Only a super admin can revert a Cloudflare One (Zero Trust) change');
}

export async function planCfRevert(accountId: string, entryId: string, time: string): Promise<CfRevertPlan> {
  const t = Date.parse(time);
  if (!/^[0-9a-f]{32}$/.test(accountId) || !/^[A-Za-z0-9-]{1,64}$/.test(entryId) || Number.isNaN(t)) throw new HttpError(400, 'Invalid audit entry');
  const token = (await credentialForAccount(accountId)).fields.apiToken;
  const e = await entryAt(token, accountId, entryId, t);
  if (!e) throw new HttpError(404, 'Cloudflare no longer has this audit entry');
  const earlier = await revertedBefore(accountId, entryId, t);
  if (earlier) refuse(`Already reverted ${earlier.at.slice(0, 16).replace('T', ' ')} UTC by ${earlier.actor_email ?? 'unknown'} — revert the new Cloudflare entry that made instead`);
  if ((e.action?.result ?? '').toLowerCase() === 'failure') refuse('This change failed, so nothing was changed and there is nothing to revert');
  const type = actionOf(e);
  const method = (e.raw?.method ?? '').toUpperCase();
  const path = apiPath(e, accountId);
  const req = unwrap(e.resource?.request);
  const res = unwrap(e.resource?.response);
  const after = stateAfter(type, e.resource?.request, e.resource?.response);
  const what = targetName(after ?? req, e.resource?.id ?? '') || path.split('/').pop()!;
  const base = { accountId, entryId, zoneId: e.zone?.id ?? '', zoneName: e.zone?.name ?? '' };
  const notes: string[] = [];
  const old = async () => {
    const h = await historyFor(token, accountId, entryId, t);
    if (!h.prev) refuse('Cloudflare Resource History has no earlier state for this resource, so its old values are not known');
    if (actionOf(h.prev!) === 'delete') refuse('Resource History says the resource did not exist before this change');
    if (h.status === 'approximate') notes.push('Cloudflare matched the earlier state approximately (Resource History “approximate”) — check the values below');
    return unwrap(stateAfter(actionOf(h.prev!), h.prev!.resource?.request, h.prev!.resource?.response));
  };
  const one = isOnePath(path);
  const done = (summary: string, m: CfRevertPlan['method'], p: string, body: unknown, skipped: string[], changedSince: boolean): CfRevertPlan =>
    ({ ...base, summary, method: m, path: p, body, skipped, changedSince, notes, cloudflareOne: one, planHash: hash(m, p, body) });

  if (type === 'create') {
    let target = path;
    if (method === 'POST') {
      // A rule added to a ruleset answers with the whole ruleset: the new rule is the one not there before.
      if (/\/rulesets\/[^/]+\/rules$/.test(path) && isObj(res) && Array.isArray(res.rules)) {
        const before = await old();
        const had = new Set((isObj(before) && Array.isArray(before.rules) ? before.rules : []).map((r) => (r as { id?: string }).id));
        const added = (res.rules as { id?: string }[]).filter((r) => r.id && !had.has(r.id));
        if (added.length !== 1) refuse('Cannot tell which rule this change added');
        target = `${path}/${added[0].id}`;
      } else {
        const id = (isObj(res) && typeof res.id === 'string' ? res.id : '') || e.resource?.id || '';
        if (!PATH_SEGMENT.test(id)) refuse('Cloudflare did not record the id of what was created');
        target = `${path}/${id}`;
      }
    } else if (method !== 'PUT') refuse(`A create made with ${method} is not reverted automatically`);
    const now = await current(token, target);
    if (now === null) refuse('It has already been deleted');
    const changedSince = now !== undefined && isObj(after) && stable(clean(pick(now, Object.keys(after)), true)) !== stable(clean(after, true));
    if (now === undefined) notes.push('The stored token could not read it now, so whether it changed since is not known');
    return done(`Delete ${what}`, 'DELETE', target, null, [], changedSince);
  }

  if (type === 'update') {
    if (method !== 'PATCH' && method !== 'PUT') refuse(`An update made with ${method} is not reverted automatically`);
    if (!isObj(req) || !Object.keys(req).length) refuse('The audit log did not record what this change sent, so it cannot be reverted');
    // A Gateway list's items added (append) or removed (remove): remove or add them back.
    if (one && method === 'PATCH' && /\/gateway\/lists\/[^/]+$/.test(path) && ('append' in req || 'remove' in req)) {
      const added = (Array.isArray(req.append) ? req.append : []).map((x) => (isObj(x) ? x.value : x)).filter((x): x is string => typeof x === 'string');
      const removed = (Array.isArray(req.remove) ? req.remove : []).filter((x): x is string => typeof x === 'string');
      if (!added.length && !removed.length) refuse('This change added and removed nothing');
      notes.push('Items added back get no description (the audit log keeps only their values)');
      notes.push('The list is not read first: an item added back that is there already, or removed that is gone already, is left as it is by Cloudflare');
      const body = { ...(removed.length ? { append: removed.map((value) => ({ value })) } : {}), ...(added.length ? { remove: added } : {}) };
      const parts = [added.length && `remove the ${added.length} item${added.length === 1 ? '' : 's'} it added`, removed.length && `add back the ${removed.length} it removed`].filter(Boolean).join(' and ');
      return done(`On ${what}: ${parts}`, 'PATCH', path, body, [], false);
    }
    const before = await old();
    if (!isObj(before)) refuse('The earlier state is not an object that can be sent back');
    // Cloudflare One objects are replaced whole by PUT (Access applications and policies, Gateway rules):
    // send the whole earlier object, not only the fields this change sent, or the rest would be cleared.
    if (one && method === 'PUT') {
      const body = clean(before, true);
      const leaked = secrets(body);
      if (leaked.length) refuse(`The earlier object includes secret or masked fields (${leaked.slice(0, 3).join(', ')}) that cannot be sent back`);
      const now = await current(token, path);
      if (now === null) refuse('It has been deleted since');
      let changedSince = false;
      if (now === undefined) notes.push('The stored token could not read it now, so whether it changed since is not known');
      else {
        const keys = Object.keys(body as object);
        if (stable(clean(pick(now, keys), true)) === stable(body)) refuse('It already has these old values');
        changedSince = isObj(after) && stable(clean(pick(now, keys), true)) !== stable(clean(pick(after, keys), true));
      }
      notes.push('Cloudflare One replaces this object whole, so the whole earlier object is sent');
      return done(`Put ${what} back as it was before this change`, 'PUT', path, body, [], changedSince);
    }
    const sent = Object.keys(req);
    const skipped = sent.filter((k) => SECRET_KEY.test(k));
    const keys = sent.filter((k) => !SECRET_KEY.test(k));
    const missing = keys.filter((k) => !(k in (before as object)));
    if (!keys.length) refuse('This change only set secret fields, which the audit log does not keep');
    if (missing.length) refuse(`The earlier state has no value for ${missing.join(', ')}`);
    const body = clean(pick(before, keys), false);
    const leaked = secrets(body);
    if (leaked.length) refuse(`The old values include secret or masked fields (${leaked.slice(0, 3).join(', ')}) that cannot be sent back`);
    const now = await current(token, path);
    if (now === null) refuse('It has been deleted since');
    let changedSince = false;
    if (now === undefined) notes.push('The stored token could not read it now, so whether it changed since is not known');
    else {
      if (stable(clean(pick(now, keys), false)) === stable(body)) refuse('It already has these old values');
      changedSince = isObj(after) && stable(clean(pick(now, keys), false)) !== stable(clean(pick(after, keys), false));
    }
    if (skipped.length) notes.push(`Not reverted (secret fields): ${skipped.join(', ')}`);
    return done(`Put the old ${keys.join(', ')} back on ${what}`, method, path, body, skipped, changedSince);
  }

  if (type === 'delete') {
    if (method !== 'DELETE') refuse(`A delete made with ${method} is not reverted automatically`);
    const parts = path.split('/');
    const id = parts.pop()!;
    const parent = parts.join('/');
    if (parts.length < 4) refuse('This delete was not of an item in a list, so it cannot be re-created');
    let before = await old();
    // A rule deleted from a ruleset: History has the ruleset; the rule is in its rules.
    if (/\/rulesets\/[^/]+\/rules$/.test(parent) && isObj(before) && Array.isArray(before.rules)) before = (before.rules as { id?: string }[]).find((r) => r.id === id);
    if (!isObj(before)) refuse('Resource History has no copy of what was deleted (a backup copy can be put back with Restore)');
    const body = clean(before, true);
    const leaked = secrets(body);
    if (leaked.length) refuse(`What was deleted includes secret or masked fields (${leaked.slice(0, 3).join(', ')}) that the audit log does not keep`);
    const now = await current(token, path);
    if (now !== null && now !== undefined) refuse('It exists again');
    if (now === undefined) notes.push('The stored token could not check whether it exists again');
    notes.push('It is created again with a new id');
    return done(`Create ${targetName(before, '') || what} again`, 'POST', parent, body, [], false);
  }

  return refuse('Only creates, updates and deletes can be reverted');
}

/** A successful revert of this entry recorded in the console's audit log (each entry is reverted once). */
async function revertedBefore(accountId: string, entryId: string, t: number) {
  const { data, error } = await db().from('audit_log').select('at, actor_email, details').eq('action', 'cloudflare.reverted').gte('at', new Date(t).toISOString()).limit(1000);
  if (error) throw new Error(`Audit query failed: ${error.message}`);
  return (data as { at: string; actor_email: string | null; details: { entryId?: string; accountId?: string } | null }[])
    .find((r) => r.details?.entryId === entryId && r.details?.accountId === accountId);
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const GLOBAL_KEY_RE = /^[0-9A-Za-z]{30,64}$/;
const sending = new Set<string>();

/**
 * Sends a reviewed revert with the Global API Key typed in for it (used for this request only —
 * never stored, logged or returned). Refuses when the request no longer matches the review.
 */
export async function applyCfRevert(me: Me, input: { accountId?: string; entryId?: string; time?: string; planHash?: string; email?: string; apiKey?: string; acknowledgeChangedSince?: boolean }) {
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!EMAIL_RE.test(email) || !GLOBAL_KEY_RE.test(apiKey)) throw new HttpError(400, 'Enter the Cloudflare account email and its Global API Key');
  const r = activeRestore();
  if (r) throw new HttpError(409, `A restore of ${r.zone} (${r.job}, by ${r.by}) is running — wait for it to finish`);
  if (activeRunId()) throw new HttpError(409, 'A backup is running — wait for it to finish');
  const key = `${input.accountId}:${input.entryId}`;
  if (sending.has(key)) throw new HttpError(409, 'This revert is already being sent');
  sending.add(key);
  try {
    const plan = await planCfRevert(String(input.accountId ?? ''), String(input.entryId ?? ''), String(input.time ?? ''));
    mayRevert(me, plan);
    if (plan.planHash !== input.planHash) throw new HttpError(409, 'Cloudflare changed since you reviewed this revert — review it again');
    if (plan.changedSince && input.acknowledgeChangedSince !== true) throw new HttpError(400, 'It changed again after this entry — confirm that reverting also undoes that');
    const auth = { 'X-Auth-Email': email, 'X-Auth-Key': apiKey };
    await checkKey(plan, auth);
    let res: Response;
    try {
      res = await fetch(`${CF_API}${plan.path}`, {
        method: plan.method, signal: AbortSignal.timeout(30_000), cache: 'no-store',
        headers: { ...auth, ...(plan.body !== null ? { 'Content-Type': 'application/json' } : {}) },
        body: plan.body !== null ? JSON.stringify(plan.body) : undefined,
      });
    } catch {
      throw new HttpError(502, 'Could not reach the Cloudflare API');
    }
    const body = (await res.json().catch(() => null)) as { success?: boolean; errors?: { code?: number; message?: string }[]; result?: { id?: string } } | null;
    const where = plan.zoneName || plan.accountId;
    const details = { entryId: plan.entryId, accountId: plan.accountId, method: plan.method, path: plan.path, summary: plan.summary, cloudflareOne: plan.cloudflareOne, auth: 'global_api_key', keyEmail: email };
    if (!res.ok || !body?.success) {
      const why = body?.errors?.map((x) => `${x.message} (${x.code})`).join('; ') || `HTTP ${res.status}`;
      await audit(me, 'cloudflare.revert_failed', where, { ...details, error: why });
      throw new HttpError(422, `Cloudflare refused the revert: ${why}`);
    }
    await audit(me, 'cloudflare.reverted', where, details);
    // What the zone explorer and the pickers show changed: read it again next time.
    await uncache(plan.zoneId ? `path:/api/zone-explorer/${plan.zoneId}/` : 'path:/api/zone-explorer/', 'path:/api/cloudflare-audit?', `cf:account-zones:${plan.accountId}`, `cf:picker-zones:${plan.accountId}`);
    return { ok: true, summary: plan.summary, newId: plan.method === 'POST' ? body.result?.id ?? null : null };
  } finally {
    sending.delete(key);
  }
}

/** The typed-in key must be valid and reach the change's zone (or account). */
async function checkKey(plan: CfRevertPlan, auth: Record<string, string>) {
  const path = plan.zoneId ? `/zones/${plan.zoneId}` : `/accounts/${plan.accountId}`;
  let res: Response;
  try {
    res = await fetch(`${CF_API}${path}`, { headers: auth, signal: AbortSignal.timeout(20_000), cache: 'no-store' });
  } catch {
    throw new HttpError(502, 'Could not reach the Cloudflare API to check the Global API Key');
  }
  const body = (await res.json().catch(() => null)) as { success?: boolean; result?: { id?: string; account?: { id?: string } } } | null;
  if (res.status >= 500) throw new HttpError(502, `Cloudflare answered HTTP ${res.status} while checking the Global API Key`);
  if (!res.ok || !body?.success) throw new HttpError(400, 'Cloudflare did not accept that email and Global API Key here');
  const ok = plan.zoneId
    ? body.result?.id === plan.zoneId && (!body.result?.account?.id || body.result.account.id === plan.accountId)
    : body.result?.id === plan.accountId;
  if (!ok) throw new HttpError(400, 'That Global API Key cannot reach this zone or account');
}
