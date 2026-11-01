import 'server-only';
import { audit } from './audit';
import type { Me } from './auth';
import { BudgetError, cfCall, cfReason, mask, ok, refused } from './cf-read';
import { accountTargets } from './cf-targets';
import { HttpError } from './http';
import { coverage, coverageOf, must, totals } from './monitor-store';
import { db } from './supabase';
import { zoneToken } from './zone-explorer';
import { ChangeError, STATUS_SORT, checkChanges, redactDestination, scrubText, type LogpushRow, type LogpushStatus, type RawJob } from './logpush-types';
import type { Coverage } from './monitor-types';
import { NEED_CREDENTIAL, authKind, cfRuntime, credentialRefused, parseRuntimeCredential, type RuntimeAnswer, type RuntimeCredential } from './cf-runtime-credential';

// Logpush jobs of every account and zone. The list comes from the monitoring check (checks/logpush.ts),
// stored in monitor_rows: no Cloudflare call to show it. Cloudflare is read live only for the one job
// being edited. Changes go through the Cloudflare action approval flow (cf-actions.ts); the console
// never shows or logs a destination beyond its host. Everything that writes, or makes Cloudflare
// write (the ownership challenge) or needs write rights (destination validation), runs with a
// credential typed in at run time (cf-runtime-credential.ts), never with a stored token.

export type LogpushScope = 'account' | 'zone';
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The token for an account or a zone, and their names. */
export async function scopeToken(scope: LogpushScope, id: string) {
  if (!ID.test(id)) throw new HttpError(400, scope === 'zone' ? 'Unknown zone' : 'Unknown account');
  if (scope === 'zone') {
    const { token, zone } = await zoneToken(id);
    return { token, scopeName: zone.name, accountId: zone.accountId, accountName: zone.accountName };
  }
  const t = (await accountTargets()).accounts.find((x) => x.accountId === id);
  if (!t) throw new HttpError(404, 'No stored credential reads that account');
  return { token: t.token, scopeName: t.accountName || id, accountId: id, accountName: t.accountName };
}

export const jobsPath = (scope: LogpushScope, id: string, jobId?: number) => `/${scope === 'zone' ? 'zones' : 'accounts'}/${id}/logpush${jobId === undefined ? '/jobs' : `/jobs/${jobId}`}`;
export const editPermission = (scope: LogpushScope) => `${scope === 'zone' ? 'Zone' : 'Account'} › Logs › Edit`;
const readPermission = (scope: LogpushScope) => `${scope === 'zone' ? 'Zone' : 'Account'} › Logs › Read`;

const budget = (err: unknown) => {
  if (err instanceof BudgetError) return new HttpError(429, 'This token’s share of Cloudflare’s rate limit is spent for now — try again in a minute');
  return err;
};

/** One job as Cloudflare has it now (with its destination — server only), or a 404. */
export async function readRawJob(token: string, scope: LogpushScope, id: string, jobId: number): Promise<RawJob> {
  let r;
  try { r = await cfCall<RawJob>(token, 'GET', jobsPath(scope, id, jobId)); } catch (err) { throw budget(err); }
  if (r.status === 404 || (ok(r) && !r.body!.result)) throw new HttpError(404, 'Cloudflare has no such Logpush job (deleted already?)');
  if (!ok(r)) throw new HttpError(refused(r) ? 403 : 502, refused(r) ? `The stored token cannot read Logpush jobs — it needs “${readPermission(scope)}” (${cfReason(r)})` : `Cloudflare: ${cfReason(r)}`);
  return r.body!.result as RawJob;
}

/** A job as the browser may see it: the destination as its host only, error text scrubbed. */
export interface JobView extends Omit<RawJob, 'destination_conf' | 'error_message'> { destination: string; error_message: string | null; scope: LogpushScope; scopeId: string; scopeName: string }

export function jobView(j: RawJob, scope: LogpushScope, scopeId: string, scopeName: string): JobView {
  const { destination_conf, error_message, logpull_options, ...rest } = j;
  return {
    ...rest, output_options: j.output_options ? mask(j.output_options) as Record<string, unknown> : null,
    logpull_options: logpull_options ? scrubText(logpull_options, 4096) : logpull_options,
    destination: redactDestination(destination_conf), error_message: error_message ? scrubText(error_message) : null, scope, scopeId, scopeName,
  };
}

/** The job being edited, read live. */
export async function liveJob(scope: LogpushScope, id: string, jobId: number): Promise<JobView> {
  const t = await scopeToken(scope, id);
  return jobView(await readRawJob(t.token, scope, id, jobId), scope, id, t.scopeName);
}

/**
 * Asks Cloudflare to write an ownership challenge file into the destination (S3, GCS, Azure, Sumo …).
 * It changes nothing in Cloudflare's settings but needs Logs Edit, so it runs with the credential typed
 * in for it (`cloudflare` in the body). Neither that nor the destination is stored or logged.
 */
export async function requestOwnership(me: Me, raw: { scope?: unknown; scopeId?: unknown; destination_conf?: unknown; cloudflare?: unknown }) {
  let cred: RuntimeCredential | null = parseRuntimeCredential(raw.cloudflare);
  if (!cred) throw new HttpError(400, NEED_CREDENTIAL);
  try {
    return await ownership(me, raw, cred);
  } finally {
    cred = null;
  }
}

async function ownership(me: Me, raw: { scope?: unknown; scopeId?: unknown; destination_conf?: unknown }, cred: RuntimeCredential) {
  const scope: LogpushScope = raw.scope === 'zone' ? 'zone' : 'account';
  const id = typeof raw.scopeId === 'string' ? raw.scopeId : '';
  let conf: string | undefined;
  try { conf = checkChanges({ destination_conf: raw.destination_conf }, 'update').destination_conf; } catch (err) { throw err instanceof ChangeError ? new HttpError(400, err.message) : err; }
  if (!conf) throw new HttpError(400, 'Enter the destination');
  const t = await scopeToken(scope, id);
  const r = await cfRuntime<{ filename?: string; message?: string; valid?: boolean }>(cred, 'POST', `/${scope === 'zone' ? 'zones' : 'accounts'}/${id}/logpush/ownership`, { destination_conf: conf });
  const host = redactDestination(conf);
  if (!runtimeOk(r)) {
    const err = runtimeRefusal(r, scope);
    await audit(me, 'logpush.ownership_failed', t.scopeName, { scope, destination: host, auth: authKind(cred), error: err.message });
    throw err;
  }
  await audit(me, 'logpush.ownership_requested', t.scopeName, { scope, destination: host, auth: authKind(cred) });
  const res = r.body!.result ?? {};
  return { filename: scrubText(res.filename ?? '', 300), message: scrubText(res.message ?? ''), valid: res.valid !== false, destination: host };
}

/** Cloudflare's own check of a destination before a job is created or moved: no change, but it needs Logs Edit (the run-time credential). */
export async function validateDestination(cred: RuntimeCredential, scope: LogpushScope, id: string, conf: string): Promise<void> {
  const r = await cfRuntime<{ valid?: boolean; message?: string }>(cred, 'POST', `/${scope === 'zone' ? 'zones' : 'accounts'}/${id}/logpush/validate/destination`, { destination_conf: conf });
  if (credentialRefused(r)) throw runtimeRefusal(r, scope);
  if (!runtimeOk(r)) throw new HttpError(400, `Cloudflare cannot use this destination: ${runtimeReason(r)}`);
  if (r.body!.result?.valid === false) throw new HttpError(400, `Cloudflare cannot use this destination${r.body!.result.message ? `: ${scrubText(r.body!.result.message)}` : ''}`);
}

export const runtimeOk = (r: RuntimeAnswer) => r.status >= 200 && r.status < 300 && !!r.body && r.body.success !== false;
export const runtimeReason = (r: RuntimeAnswer) => scrubText(r.body?.errors?.map((e) => e.message).filter(Boolean).join('; ') || `HTTP ${r.status}`);

/**
 * Cloudflare's refusal of a run-time change. A credential it did not accept, or one without Logs Edit,
 * is a 409, so an approval stays pending and can be approved again with another credential.
 */
export function runtimeRefusal(r: RuntimeAnswer, scope: LogpushScope): HttpError {
  if (credentialRefused(r)) return new HttpError(409, `Cloudflare refused the credential you entered: it needs “${editPermission(scope)}” (Logs Edit) on this ${scope}, or use a Global API Key of a member who may edit logs (${runtimeReason(r)})`);
  return new HttpError(502, `Cloudflare: ${runtimeReason(r)}`);
}

// ── The stored list ─────────────────────────────────────────────────────────

export interface LogpushPage {
  rows: LogpushRow[];
  total: number;
  offset: number;
  counts: Record<string, number>;
  coverage: Coverage;
  generatedAt: string;
}

/** One page of jobs, worst first: ?status= (uses the sort key), scope, and a text search. */
export async function listJobs(opts: { status?: LogpushStatus; scope?: LogpushScope; q?: string; offset: number; limit: number }): Promise<LogpushPage> {
  let q = db().from('monitor_rows').select('data', { count: 'exact' }).eq('check_id', 'logpush').eq('section', 'jobs');
  if (opts.status) q = q.eq('sort', STATUS_SORT[opts.status]);
  if (opts.scope) q = q.eq('scope_kind', opts.scope);
  const term = (opts.q ?? '').toLowerCase().replace(/[%_*,()\\]/g, ' ').trim().slice(0, 100);
  if (term) q = q.ilike('search', `%${term}%`);
  const [res, counts, cov] = await Promise.all([
    q.order('sort', { ascending: true }).order('id', { ascending: true }).range(opts.offset, opts.offset + opts.limit - 1),
    totals('logpush'),
    coverage(),
  ]);
  const rows = must(res, 'Reading Logpush jobs') as { data: LogpushRow }[];
  return { rows: rows.map((r) => r.data), total: res.count ?? rows.length, offset: opts.offset, counts, coverage: coverageOf(cov, 'logpush'), generatedAt: new Date().toISOString() };
}
