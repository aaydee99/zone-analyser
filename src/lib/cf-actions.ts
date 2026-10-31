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

// Changes the console makes in Cloudflare besides a restore: purging the cache, and rolling a Worker
// or a Pages project back to an earlier deployment. An admin asks; a super admin approves (or acts
// directly). Each runs with the stored token for that zone or account, so the token needs the
// matching write permission; Cloudflare's refusal is shown as it is.

export type CfAction =
  | { type: 'purge'; zoneId: string; zoneName: string; mode: 'everything' | 'files' | 'tags' | 'hosts' | 'prefixes'; values: string[] }
  | { type: 'worker-rollback'; accountId: string; accountName: string; script: string; versionId: string; versionLabel: string }
  | { type: 'pages-rollback'; accountId: string; accountName: string; project: string; deploymentId: string; deploymentLabel: string };

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
  throw new HttpError(400, 'Unknown action');
}

export function describe(a: CfAction): { title: string; details: string[] } {
  if (a.type === 'purge') {
    const what = a.mode === 'everything' ? 'everything' : `${a.values.length} ${a.mode === 'files' ? 'URL' : a.mode.replace(/es$|s$/, '')}${a.values.length === 1 ? '' : 's'}`;
    return { title: `Purge ${what} from the cache of ${a.zoneName}`, details: a.mode === 'everything' ? ['Every cached file of the zone is dropped; the origin serves them again until they are cached anew.'] : [`Purge by ${a.mode}:`, ...a.values.slice(0, 20), ...(a.values.length > 20 ? [`…and ${a.values.length - 20} more`] : [])] };
  }
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
    try {
      const done = await executeAction(a);
      await audit(me, 'cloudflare.action', d.title, { action: a.type, result: done, ...noteDetails(note) });
      return { done };
    } catch (err) {
      await audit(me, 'cloudflare.action_failed', d.title, { action: a.type, error: err instanceof Error ? err.message : String(err), ...noteDetails(note) });
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
