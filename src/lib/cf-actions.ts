import 'server-only';
import { audit } from './audit';
import type { Me } from './auth';
import { cfCall, cfList, cfOne, cfReason, ok, refused } from './cf-read';
import { accountTargets } from './cf-targets';
import { HttpError } from './http';
import { can } from './rbac';
import { newApproval, requestNote, type Approval } from './approvals-store';
import { noteDetails } from './change-note';
import { zoneToken } from './zone-explorer';
import crypto from 'node:crypto';
import { openRelay, sealRelay } from './vault';
import { db } from './supabase';
import { jobsPath, readRawJob, runtimeOk, runtimeRefusal, scopeToken, validateDestination, type LogpushScope } from './logpush';
import { NEED_CREDENTIAL, authKind, cfRuntime, parseRuntimeCredential, runtimeCredential, withRuntimeCredential } from './cf-runtime-credential';
import { ChangeError, checkChanges, diffLines, fieldLines, summarizeJob, type LogpushChanges, type RawJob } from './logpush-types';

// Changes the console makes in Cloudflare besides a restore: purging the cache, rolling a Worker
// or a Pages project back to an earlier deployment, and creating, changing or deleting a Logpush
// job. An admin asks; a super admin approves (or acts directly). A purge or rollback runs with the
// stored token for that zone or account, so the token needs the matching write permission;
// Cloudflare's refusal is shown as it is. A Logpush change runs only with an API token or Global
// API Key the super admin types in when it runs (cf-runtime-credential.ts), never a stored token.

type Sealed = Awaited<ReturnType<typeof sealRelay>>;

export type CfAction =
  | { type: 'purge'; zoneId: string; zoneName: string; mode: 'everything' | 'files' | 'tags' | 'hosts' | 'prefixes'; values: string[] }
  | { type: 'worker-rollback'; accountId: string; accountName: string; script: string; versionId: string; versionLabel: string }
  | { type: 'pages-rollback'; accountId: string; accountName: string; project: string; deploymentId: string; deploymentLabel: string }
  | LogpushAction;

/**
 * A Logpush job change. `before` / `after` are what the approver sees (destinations as their host
 * only); `print` is the job as it was asked about, so a job changed meanwhile is not overwritten.
 * The destination and ownership challenge (they hold credentials) are sealed with the server key in
 * `secret`, never shown, and opened only to send them to Cloudflare.
 */
export interface LogpushAction {
  type: 'logpush'; op: 'create' | 'update' | 'delete'; scope: LogpushScope; scopeId: string; scopeName: string;
  jobId?: number; jobLabel: string; changes: Omit<LogpushChanges, 'destination_conf' | 'ownership_challenge'>;
  before: Record<string, string>; after: Record<string, string>; print?: string; ownership?: boolean;
  secret?: { nonce: string; sealed: Sealed };
}

const PURGE_MODES = ['everything', 'files', 'tags', 'hosts', 'prefixes'] as const;
const MAX_VALUES = 100;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

const str = (v: unknown, label: string, max = 200) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > max) throw new HttpError(400, `${label} is missing or too long`);
  return s;
};

/** Checks what the browser sent and names everything from Cloudflare's own lists, not from the request. */
export async function validateAction(raw: unknown): Promise<CfAction> {
  const a = (raw ?? {}) as Record<string, unknown>;
  if (a.type === 'purge') {
    const zoneId = str(a.zoneId, 'Zone');
    const mode = PURGE_MODES.find((m) => m === a.mode);
    if (!mode) throw new HttpError(400, 'Choose what to purge');
    const { zone } = await zoneToken(zoneId);
    let values: string[] = [];
    if (mode !== 'everything') {
      values = (Array.isArray(a.values) ? a.values : []).map((v) => String(v).trim()).filter(Boolean);
      if (!values.length) throw new HttpError(400, 'List at least one value to purge');
      if (values.length > MAX_VALUES) throw new HttpError(400, `At most ${MAX_VALUES} values in one purge`);
      for (const v of values) {
        if (v.length > 1024) throw new HttpError(400, 'A value is longer than 1,024 characters');
        if (mode === 'files' && !/^https?:\/\//i.test(v)) throw new HttpError(400, `Not a full URL: ${v}`);
        if (mode === 'hosts' && !HOST.test(v)) throw new HttpError(400, `Not a host name: ${v}`);
        if (mode === 'prefixes' && /^https?:\/\//i.test(v)) throw new HttpError(400, `Write a prefix without http:// or https://: ${v}`);
      }
    }
    return { type: 'purge', zoneId, zoneName: zone.name, mode, values };
  }
  if (a.type === 'worker-rollback' || a.type === 'pages-rollback') {
    const accountId = str(a.accountId, 'Account');
    const target = (await accountTargets()).accounts.find((x) => x.accountId === accountId);
    if (!target) throw new HttpError(404, 'No stored credential reads that account');
    if (a.type === 'worker-rollback') {
      const script = str(a.script, 'Worker');
      const versionId = str(a.versionId, 'Version');
      if (!ID.test(script) || !ID.test(versionId.replace(/-/g, ''))) throw new HttpError(400, 'Unknown Worker or version');
      const versions = await workerVersions(accountId, script);
      const v = versions.versions.find((x) => x.id === versionId);
      if (!v) throw new HttpError(404, 'That version is not among the Worker’s recent versions');
      if (v.current) throw new HttpError(409, 'That version is already serving all traffic');
      return { type: 'worker-rollback', accountId, accountName: target.accountName, script, versionId, versionLabel: v.label };
    }
    const project = str(a.project, 'Project');
    const deploymentId = str(a.deploymentId, 'Deployment');
    if (!ID.test(project) || !ID.test(deploymentId.replace(/-/g, ''))) throw new HttpError(400, 'Unknown project or deployment');
    const deployments = await pagesDeployments(accountId, project);
    const d = deployments.find((x) => x.id === deploymentId);
    if (!d) throw new HttpError(404, 'That deployment is not among the project’s recent production deployments');
    if (d.current) throw new HttpError(409, 'That deployment is already live');
    return { type: 'pages-rollback', accountId, accountName: target.accountName, project, deploymentId, deploymentLabel: d.label };
  }
  if (a.type === 'logpush') return validateLogpush(a);
  throw new HttpError(400, 'Unknown action');
}

// ── Logpush jobs ────────────────────────────────────────────────────────────

const LOGPUSH_OPS = ['create', 'update', 'delete'] as const;
const MUTABLE = ['name', 'dataset', 'enabled', 'destination_conf', 'filter', 'frequency', 'logpull_options', 'output_options', 'max_upload_bytes', 'max_upload_records', 'max_upload_interval_seconds', 'kind'] as const;
const EMPTY: Record<string, unknown> = { name: '', filter: '', frequency: '', enabled: false, output_options: null, max_upload_bytes: 0, max_upload_records: 0, max_upload_interval_seconds: 0 };

/** The job's settings (not its last run), to tell whether it changed since the request. */
const fingerprint = (j: RawJob) => crypto.createHash('sha256').update(JSON.stringify(MUTABLE.map((k) => j[k] ?? null))).digest('base64url');
/** The fields of `job` that `keys` name, as summarizeJob shows them. */
const pick = (job: RawJob, keys: string[]) => summarizeJob(Object.fromEntries(keys.map((k) => [k, (job as unknown as Record<string, unknown>)[k] ?? EMPTY[k] ?? null])) as Partial<RawJob>);

async function validateLogpush(a: Record<string, unknown>): Promise<LogpushAction> {
  const op = LOGPUSH_OPS.find((x) => x === a.op);
  if (!op) throw new HttpError(400, 'Choose create, update or delete');
  const scope: LogpushScope | null = a.scope === 'zone' ? 'zone' : a.scope === 'account' ? 'account' : null;
  if (!scope) throw new HttpError(400, 'Choose an account or a zone');
  const scopeId = str(a.scopeId, scope === 'zone' ? 'Zone' : 'Account', 64);
  const t = await scopeToken(scope, scopeId);
  let changes: LogpushChanges = {};
  if (op !== 'delete') {
    try { changes = checkChanges(a.changes, op); } catch (err) { throw err instanceof ChangeError ? new HttpError(400, err.message) : err; }
  }
  const { destination_conf, ownership_challenge, ...plain } = changes;
  const base = { type: 'logpush' as const, op, scope, scopeId, scopeName: t.scopeName, changes: plain, ownership: !!ownership_challenge };
  let out: LogpushAction;
  // Cloudflare's destination check needs Logs Edit, so it runs with the change (executeLogpush).
  if (op === 'create') {
    out = { ...base, jobLabel: plain.name || plain.dataset!, before: {}, after: summarizeJob({ ...plain, enabled: plain.enabled ?? true, destination_conf }) };
  } else {
    const jobId = Number(a.jobId);
    if (!Number.isInteger(jobId) || jobId < 1) throw new HttpError(400, 'Unknown Logpush job');
    const job = await readRawJob(t.token, scope, scopeId, jobId);
    const jobLabel = job.name || `#${job.id}`;
    if (op === 'delete') {
      out = { ...base, jobId, jobLabel, print: fingerprint(job), before: pick(job, ['name', 'dataset', 'enabled', 'destination_conf', 'filter']), after: {} };
    } else {
      const keys = [...Object.keys(plain), ...(destination_conf ? ['destination_conf'] : [])];
      const before = pick(job, keys);
      const after = summarizeJob({ ...plain, ...(destination_conf ? { destination_conf } : {}) } as Partial<RawJob>);
      // A new destination with the same host still changes (its path or keys): say so.
      if (destination_conf && destination_conf !== job.destination_conf && after.destination === before.destination) after.destination = `${after.destination} (path or keys changed)`;
      if (!diffLines(before, after).length && !ownership_challenge) throw new HttpError(400, 'Nothing would change');
      out = { ...base, jobId, jobLabel, print: fingerprint(job), before, after };
    }
  }
  if (destination_conf || ownership_challenge) {
    const nonce = crypto.randomBytes(12).toString('hex');
    out.secret = { nonce, sealed: await sealRelay(Buffer.from(JSON.stringify({ destination_conf, ownership_challenge }), 'utf8'), `logpush-action:${nonce}`) };
  }
  return out;
}

function describeLogpush(a: LogpushAction): { title: string; details: string[] } {
  const where = `${a.scope === 'zone' ? 'zone' : 'account'} ${a.scopeName}`;
  const head = `${a.scope === 'zone' ? 'Zone' : 'Account'} ${a.scopeName}`;
  if (a.op === 'create') return { title: `Create a Logpush job for ${a.changes.dataset} in ${where}`, details: [head, ...fieldLines(a.after), ...(a.ownership ? ['With the ownership challenge from the destination.'] : [])] };
  if (a.op === 'delete') return { title: `Delete Logpush job “${a.jobLabel}” in ${where}`, details: [head, 'Its logs stop being pushed; the destination keeps what it already has.', ...fieldLines(a.before)] };
  const lines = diffLines(a.before, a.after);
  const onlyToggle = Object.keys(a.after).length === 1 && 'enabled' in a.after;
  const title = onlyToggle ? `Turn ${a.changes.enabled ? 'on' : 'off'} Logpush job “${a.jobLabel}” in ${where}` : `Change Logpush job “${a.jobLabel}” in ${where}`;
  return { title, details: [head, ...lines, ...(a.ownership ? ['With a new ownership challenge from the destination.'] : [])] };
}

/**
 * Runs the change with the credential typed in for it (runtimeCredential: a super admin acting, or
 * approving). The stored token only reads the job, to see that it did not change since the request.
 * A missing, wrong or insufficient credential is a 409, so an approval stays pending.
 */
async function executeLogpush(a: LogpushAction): Promise<string> {
  const cred = runtimeCredential();
  const t = await scopeToken(a.scope, a.scopeId);
  const secret = a.secret ? JSON.parse((await openRelay(a.secret.sealed, `logpush-action:${a.secret.nonce}`)).toString('utf8')) as Pick<LogpushChanges, 'destination_conf' | 'ownership_challenge'> : {};
  const fail = (r: Parameters<typeof runtimeRefusal>[0]) => runtimeRefusal(r, a.scope);
  let done: string;
  if (a.op === 'create') {
    await validateDestination(cred, a.scope, a.scopeId, secret.destination_conf!);
    const r = await cfRuntime<{ id?: number }>(cred, 'POST', jobsPath(a.scope, a.scopeId), { ...a.changes, ...secret });
    if (!runtimeOk(r)) throw fail(r);
    done = `Created Logpush job ${r.body!.result?.id ? `#${r.body!.result.id} ` : ''}for ${a.changes.dataset} in ${a.scopeName}`;
  } else {
    const job = await readRawJob(t.token, a.scope, a.scopeId, a.jobId!);
    if (a.print && fingerprint(job) !== a.print) throw new HttpError(409, 'The job changed in Cloudflare since this was asked — ask again with its current settings');
    if (a.op === 'delete') {
      const r = await cfRuntime(cred, 'DELETE', jobsPath(a.scope, a.scopeId, a.jobId));
      if (!runtimeOk(r)) throw fail(r);
      done = `Deleted Logpush job “${a.jobLabel}” in ${a.scopeName}`;
    } else {
      if (secret.destination_conf && secret.destination_conf !== job.destination_conf) await validateDestination(cred, a.scope, a.scopeId, secret.destination_conf);
      const r = await cfRuntime(cred, 'PUT', jobsPath(a.scope, a.scopeId, a.jobId), { ...a.changes, ...secret });
      if (!runtimeOk(r)) throw fail(r);
      done = `${describeLogpush(a).title.replace(/^Turn/, 'Turned').replace(/^Change/, 'Changed')}`;
    }
  }
  // The Logpush page shows the job as it is now after the check reads this scope again: a zone at
  // once; an account's unit is made due (asking by account would read every zone of it too).
  if (a.scope === 'zone') void import('./monitor-queue').then((m) => m.requestRun({ checks: ['logpush'], zoneId: a.scopeId })).catch(() => {});
  else void db().from('monitor_targets').update({ next_due_at: new Date().toISOString(), priority: 1 }).eq('check_id', 'logpush').eq('scope_kind', 'account').eq('scope_id', a.scopeId).then(() => {}, () => {});
  return done;
}

export function describe(a: CfAction): { title: string; details: string[] } {
  if (a.type === 'purge') {
    const what = a.mode === 'everything' ? 'everything' : `${a.values.length} ${a.mode === 'files' ? 'URL' : a.mode.replace(/es$|s$/, '')}${a.values.length === 1 ? '' : 's'}`;
    return { title: `Purge ${what} from the cache of ${a.zoneName}`, details: a.mode === 'everything' ? ['Every cached file of the zone is dropped; the origin serves them again until they are cached anew.'] : [`Purge by ${a.mode}:`, ...a.values.slice(0, 20), ...(a.values.length > 20 ? [`…and ${a.values.length - 20} more`] : [])] };
  }
  if (a.type === 'logpush') return describeLogpush(a);
  if (a.type === 'worker-rollback') return { title: `Roll Worker “${a.script}” back`, details: [`Account ${a.accountName || a.accountId}`, `Deploy version ${a.versionLabel} to 100% of traffic. Bindings and secrets are not rolled back.`] };
  return { title: `Roll Pages project “${a.project}” back`, details: [`Account ${a.accountName || a.accountId}`, `Make deployment ${a.deploymentLabel} live again.`] };
}

async function accountToken(accountId: string) {
  const t = (await accountTargets()).accounts.find((x) => x.accountId === accountId);
  if (!t) throw new HttpError(404, 'No stored credential reads that account');
  return t.token;
}

const refusal = (r: { status: number; body: { errors?: { message?: string }[] } | null }, need: string) =>
  new HttpError(refused(r) ? 403 : 502, refused(r) ? `Cloudflare refused it: the stored token needs “${need}” (${cfReason(r)})` : `Cloudflare: ${cfReason(r)}`);

/** Does it. Returns one line on what happened. */
export async function executeAction(a: CfAction): Promise<string> {
  if (a.type === 'purge') {
    const { token } = await zoneToken(a.zoneId);
    const body = a.mode === 'everything' ? { purge_everything: true } : { [a.mode]: a.values };
    const r = await cfCall(token, 'POST', `/zones/${a.zoneId}/purge_cache`, body);
    if (!ok(r)) throw refusal(r, 'Zone › Cache Purge › Purge');
    return describe(a).title.replace(/^Purge/, 'Purged');
  }
  if (a.type === 'logpush') return executeLogpush(a);
  const token = await accountToken(a.accountId);
  if (a.type === 'worker-rollback') {
    const r = await cfCall(token, 'POST', `/accounts/${a.accountId}/workers/scripts/${encodeURIComponent(a.script)}/deployments`, {
      strategy: 'percentage', versions: [{ version_id: a.versionId, percentage: 100 }], annotations: { 'workers/message': 'Rollback from the console' },
    });
    if (!ok(r)) throw refusal(r, 'Account › Workers Scripts › Edit');
    return `Worker “${a.script}” now serves version ${a.versionLabel}`;
  }
  const r = await cfCall(token, 'POST', `/accounts/${a.accountId}/pages/projects/${encodeURIComponent(a.project)}/deployments/${encodeURIComponent(a.deploymentId)}/rollback`);
  if (!ok(r)) throw refusal(r, 'Account › Cloudflare Pages › Edit');
  return `Pages project “${a.project}” now serves deployment ${a.deploymentLabel}`;
}

/** Super admins act at once; admins ask, and a super admin approves on the Approvals page. */
export async function requestAction(me: Me, raw: unknown): Promise<{ done?: string; approval?: Approval }> {
  const a = await validateAction(raw);
  const d = describe(a);
  const direct = can(me.role, 'restore:approve');
  // Every action kind: the body's `reason` and `ticket` go with the request (and into the audit log).
  const note = await requestNote(raw, !direct);
  if (direct) {
    // A Logpush change runs with the credential typed in with it (`cloudflare` in the body), never a stored token.
    const cred = a.type === 'logpush' ? parseRuntimeCredential((raw as { cloudflare?: unknown } | null)?.cloudflare) : null;
    if (a.type === 'logpush' && !cred) throw new HttpError(400, NEED_CREDENTIAL);
    const auth = cred ? { auth: authKind(cred) } : {};
    try {
      const done = await withRuntimeCredential(cred, () => executeAction(a));
      await audit(me, 'cloudflare.action', d.title, { action: a.type, result: done, ...auth, ...noteDetails(note) });
      return { done };
    } catch (err) {
      await audit(me, 'cloudflare.action_failed', d.title, { action: a.type, error: err instanceof Error ? err.message : String(err), ...auth, ...noteDetails(note) });
      throw err;
    }
  }
  const approval = newApproval({ kind: 'cloudflare', requestedBy: { id: me.id, email: me.email, role: me.role }, title: d.title, details: d.details, action: a, ...(note.reason || note.ticket ? { note } : {}) });
  await audit(me, 'approval.requested', d.title, { approvalId: approval.id, kind: 'cloudflare', action: a.type, ...noteDetails(note) });
  return { approval };
}

// ── What a rollback can go back to ──────────────────────────────────────────

interface RawVersion { id: string; number?: number; metadata?: { created_on?: string; author_email?: string; source?: string; message?: string } ; annotations?: Record<string, string> }
interface RawDeployment { id: string; created_on?: string; versions?: { version_id: string; percentage: number }[] }

/** A Worker's recent versions, newest first, and which one serves traffic now. */
export async function workerVersions(accountId: string, script: string) {
  const token = await accountToken(accountId);
  const base = `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}`;
  const [versions, deps] = await Promise.all([
    cfList<RawVersion>(token, `${base}/versions`, { perPage: 50, max: 50 }),
    // Cloudflare answers { deployments: [...] } in `result`, the one serving traffic first.
    cfOne<{ deployments?: RawDeployment[] }>(token, `${base}/deployments`).then((r) => r?.deployments ?? []).catch(() => [] as RawDeployment[]),
  ]);
  const live = new Set((deps[0]?.versions ?? []).filter((v) => v.percentage > 0).map((v) => v.version_id));
  return {
    script,
    versions: versions.map((v) => ({
      id: v.id, label: v.number !== undefined ? `#${v.number}` : v.id.slice(0, 8), createdOn: v.metadata?.created_on ?? null,
      author: v.metadata?.author_email ?? '', source: v.metadata?.source ?? '', message: v.annotations?.['workers/message'] ?? v.metadata?.message ?? '', current: live.has(v.id),
    })),
  };
}

interface RawPagesDeployment { id: string; short_id?: string; created_on?: string; environment?: string; url?: string; deployment_trigger?: { metadata?: { commit_message?: string; branch?: string; commit_hash?: string } }; latest_stage?: { status?: string } }

/** A Pages project's recent production deployments that succeeded, newest first. */
export async function pagesDeployments(accountId: string, project: string) {
  const token = await accountToken(accountId);
  const list = await cfList<RawPagesDeployment>(token, `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/deployments?env=production`, { perPage: 25, max: 25 });
  const good = list.filter((d) => (d.environment ?? 'production') === 'production' && d.latest_stage?.status !== 'failure');
  return good.map((d, i) => ({
    id: d.id, label: d.short_id ?? d.id.slice(0, 8), createdOn: d.created_on ?? null, url: d.url ?? '',
    commit: d.deployment_trigger?.metadata?.commit_message?.split('\n')[0] ?? '', branch: d.deployment_trigger?.metadata?.branch ?? '', current: i === 0,
  }));
}
