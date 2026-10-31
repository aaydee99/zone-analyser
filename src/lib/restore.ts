import 'server-only';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { HttpError } from './http';
import { credentialForRun, storageOf } from './vault';
import { listZones } from './providers';
import { uncache } from './cache';
import { saveRecord, type RestoreStep } from './restore-history';
import { newApproval, requestNote, type Approval } from './approvals-store';
import { noteDetails, type ChangeNote } from './change-note';
import { can } from './rbac';
import { bucketTarget, getObject, listObjects, type BucketTarget } from './bucket-store';
import { accountChanges } from './cf-audit';
import { CF_RETENTION_DAYS, type CfChange } from './cf-audit-report';
import { diff, redact, type FieldChange } from './cf-classify';
import {
  asExtra, dependents, importBlock, importIdFor, inconsistentAttrs, isProviderEquivalent, unsafeBlock, inZone, isConfigChange, layout, liveExtras, otherErrors, parseBackupFolder, parseBlocks, planErrors, restoreCandidates,
  reusedExtras, withDependencies,
  type PlanError, type RestoreCandidate, type TfBlock,
} from './restore-hcl';
import { ensureTools, resolveTools } from './tools';
import { accountLockKey, activeRunId, augmentedEnvPath } from './runner';
import { LockBusy, acquireShared, activeRestore, jobsPaused, setActiveRestore, type ActiveRestore, type SharedLock } from './job-lock';
import { getSettings } from './settings';
import { LIVE_ZONE_TYPES } from './tf-zone-types';
import { SKIP_IMPORT } from './tf-import-ids';
import { startReadOnlyProxy, type ReadOnlyProxy } from './cf-readonly-proxy';
import { DATA_DIR, newId } from './store';
import { audit } from './audit';
import type { Me } from './auth';

// Restore one zone's changed configuration from the newest backup in R2 / S3:
//   prepare → latest backup folder for the zone + audit-log changes since it + matching blocks
//   compare → (optional) every block of the backup imported and planned against the live zone, so
//             every deleted, changed or disabled resource shows — whatever the audit log says
//   plan    → Terraform dir with ONLY the chosen blocks (+ import blocks), init + plan -out
//   apply   → applies exactly that saved plan, then a check plan confirms nothing is left
// Only one Terraform job runs at a time; sessions live in memory for two hours.

const DAY = 86_400_000;
const SESSION_TTL = 2 * 3600_000;
/** A plan older than this must be made again before it can be applied. */
export const PLAN_MAX_AGE_MS = 30 * 60_000;
const JOB_TIMEOUT_MS = 20 * 60_000;
const RESTORES_DIR = path.join(DATA_DIR, 'restores');
const CONSOLE_ENV_RE = /^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|VAULT_|CONSOLE_|REDIS_|RELAY_|TURNSTILE_|WORKER_GITHUB_)/i;
const STRIP_ENV = ['CF_API_TOKEN', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

export type RestoreState = 'prepared' | 'scanning' | 'scanned' | 'planning' | 'planned' | 'plan-failed' | 'applying' | 'applied' | 'apply-failed' | 'matched';

/** Done: applied, or a comparison or plan found the live zone already matches the backup. */
const DONE = (s: { state: RestoreState }) => s.state === 'applied' || s.state === 'matched';
const doneError = (s: { state: RestoreState }) => new HttpError(409, s.state === 'matched' ? 'This restore is complete: the live zone matches the backup. Start a new one' : 'This restore was already applied. Start a new one');

export interface PlannedChange {
  address: string;
  /** Terraform actions: ["update"], ["create"], ["delete","create"] (replace), ["no-op"] … */
  actions: string[];
  importing: boolean;
  dependency: boolean;
  /** Backup value vs live value, field by field (live → backup). */
  fields: FieldChange[];
  /** Made through the Cloudflare API at apply, not by Terraform. */
  api?: boolean;
}

export interface RestoreView {
  id: string;
  state: RestoreState;
  createdBy: string;
  createdAt: string;
  zone: { id: string; name: string };
  account: { id: string; credentialId: string; credentialName: string };
  source: {
    kind: 'r2' | 'aws'; credentialName: string; bucket: string; folder: string; backupTime: string; newestFolder: string; skippedNewer: string[]; warnings: string[];
    /** Checked against its completion manifest (_backup-complete.json), or unverified (a backup made before those). */
    verified: boolean;
    /** "verified: …" or "unverified (made before completion manifests)". */
    verification: string;
    /** The newer folders that were not used, and why ("no files for <zone>", or "not usable: …"). */
    skipped: { folder: string; reason: string }[];
  };
  /** Configuration changes (create/update/delete) to this zone since the backup, newest first. */
  changes: CfChange[];
  /** Audit entries left out: reads (backup runs, lookups), failed requests, cache purges… */
  ignored: number;
  /** The newest ignored entries (up to 100), so it is visible what was left out. */
  ignoredEntries: { id: string; time: string; method: string; uri: string; actionType: string; result: string }[];
  auditTruncated: boolean;
  candidates: (RestoreCandidate & { blockText?: string })[];
  selected: string[];
  /** Resource blocks in the backup for this zone. */
  blockCount: number;
  /** Result of "Compare everything" (every backup block vs the live zone). */
  scan: { at: string; total: number; differs: number; missing: number; matches: number; unchecked: number; extra: number; listFailed: string[]; error?: string } | null;
  plan: { at: string; changes: PlannedChange[]; hasReplace: boolean; hasDelete: boolean; noChanges: boolean } | null;
  appliedAt: string | null;
  verified: boolean | null;
  /** The last job that was cancelled, and by whom. */
  cancelled: { job: ActiveRestore['job']; by: string; at: string } | null;
  /** An admin's apply waiting for a super admin (the plan is locked meanwhile). */
  approval: { id: string; requestedBy: string; requestedAt: string; expiresAt: string } | null;
  log: string[];
}

interface Session extends Omit<RestoreView, 'blockCount'> {
  token: string;
  provider: string;
  blocks: TfBlock[];
  /** Live resources the backup does not have (from the last comparison), as blocks to import and delete. */
  extras: TfBlock[];
  dir: string;
  expires: number;
  /** Email Routing on/off in the backup (its API snapshot); null when the backup has none. */
  emailRouting: { enabled: boolean } | null;
  /** Planned changes Terraform cannot make, applied through the API with the Global API Key. */
  apiChanges: ApiChange[];
  /** The current plan has Terraform changes (tfplan): false when it is API changes only. */
  tfPlanned: boolean;
  appliedBy: string | null;
  steps: RestoreStep[];
  /** The tool running for the current job (terraform / cf-terraforming), so a cancel can stop it. */
  child: ChildProcess | null;
  cancelRequested: boolean;
  /**
   * terraform.tfstate after an apply that failed or was cancelled: what that apply already created
   * or imported. The next plan starts from it, and the next comparison compares those objects
   * (so nothing is created twice). Cleared by an apply that succeeds and by a finished comparison.
   */
  keptState: string | null;
}

/** Email Routing on/off: Terraform cannot set it (cloudflare_email_routing_dns reads back empty). */
const EMAIL_ROUTING_KEY = 'api:email_routing';
const EMAIL_ROUTING_LABEL = 'Email Routing (enabled)';
interface ApiChange { key: typeof EMAIL_ROUTING_KEY; enabled: boolean }

interface Store { sessions: Map<string, Session>; busy: string | null; lock?: SharedLock | null }
const g = globalThis as unknown as { __cfRestore?: Store };
const store: Store = (g.__cfRestore ??= { sessions: new Map<string, Session>(), busy: null });

/**
 * Global API Keys of applies waiting for a super admin, by approval id. Memory only: never written to
 * disk, the database or a log, and dropped as soon as the request is decided, withdrawn or expires.
 */
const gk = globalThis as unknown as { __restoreHeldKeys?: Map<string, { email: string; apiKey: string; restoreId: string }> };
const heldKeys = (gk.__restoreHeldKeys ??= new Map());

function sweep() {
  const now = Date.now();
  for (const [id, s] of store.sessions) {
    if (s.expires < now && store.busy !== id) { store.sessions.delete(id); fs.rmSync(s.dir, { recursive: true, force: true }); }
  }
  for (const [aid, k] of heldKeys) if (!store.sessions.has(k.restoreId)) heldKeys.delete(aid);
}

const view = (s: Session): RestoreView => {
  const { token: _t, provider: _p, blocks, extras, dir: _d, expires: _e, emailRouting: _er, apiChanges: _ac, tfPlanned: _tp, appliedBy: _ab, steps: _st, child: _ch, cancelRequested: _cr, keptState: _ks, ...rest } = s;
  const byAddr = new Map([...blocks, ...extras].map((b) => [b.address, b.text]));
  return { ...rest, blockCount: blocks.length, candidates: s.candidates.map((c) => ({ ...c, blockText: c.address ? redactText(byAddr.get(c.address) ?? '') : undefined })), log: [...s.log] };
};

/** Mask secret-looking HCL attributes before showing a block. */
function redactText(t: string) {
  return t.replace(/^(\s*[a-z_0-9]*(?:secret|password|token|private_key|psk|credential)[a-z_0-9]*\s*=\s*)"(?:[^"\\]|\\.)*"/gim, '$1"••••••••"');
}

/** Notes a step and saves the restore's history record (addresses and actions only, no values or secrets). */
function track(s: Session, step: string, by: string) {
  s.steps.push({ at: new Date().toISOString(), step, by });
  saveRecord({
    id: s.id, state: s.state, createdBy: s.createdBy, createdAt: s.createdAt, zone: s.zone,
    account: { id: s.account.id, credentialName: s.account.credentialName },
    source: { kind: s.source.kind, bucket: s.source.bucket, folder: s.source.folder, backupTime: s.source.backupTime },
    auditChanges: s.changes.length, selected: s.selected.length,
    scan: s.scan ? { at: s.scan.at, total: s.scan.total, differs: s.scan.differs, missing: s.scan.missing, matches: s.scan.matches, unchecked: s.scan.unchecked, extra: s.scan.extra } : null,
    plan: s.plan ? { at: s.plan.at, changes: s.plan.changes.map((c) => ({ address: c.address, actions: c.actions, ...(c.api ? { api: true } : {}) })), hasReplace: s.plan.hasReplace, hasDelete: s.plan.hasDelete, noChanges: s.plan.noChanges } : null,
    appliedAt: s.appliedAt, appliedBy: s.appliedBy, verified: s.verified, cancelled: s.cancelled, steps: s.steps, log: s.log,
  });
}

/** Ids of the restore sessions that still exist (they can be continued in New restore). */
export function liveRestoreIds(): Set<string> {
  sweep();
  return new Set(store.sessions.keys());
}

export function getRestore(id: string): RestoreView {
  sweep();
  const s = store.sessions.get(id);
  if (!s) throw new HttpError(404, 'Restore session not found or expired — start again');
  return view(s);
}

// ── Prepare ───────────────────────────────────────────────────────────────────

export interface PrepareInput {
  cloudflareCredentialId: string;
  zoneId: string;
  /** R2 or S3 of the same account set; bucket blank = its default. */
  storage: { kind: 'r2' | 'aws'; bucket?: string };
}

/**
 * Written by backup.js LAST, at the root of each backup folder: a folder with it finished, and its
 * files can be checked against it. Folders from before completion manifests have none.
 */
export const COMPLETE_MANIFEST = '_backup-complete.json';
interface CompleteManifest { version: 1; createdAt: string; files: { path: string; bytes: number; sha256: string }[] }
const UNVERIFIED_NOTE = 'unverified (made before completion manifests)';
/** How many older folders are looked at for a manifest before a folder without one counts as made before them. */
const MANIFEST_LOOKBACK = 5;

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
/** Text read from the bucket matches a manifest entry (a UTF-8 BOM is dropped when the text is read, so it is tried both ways). */
const matchesEntry = (text: string, e: { bytes: number; sha256: string }) => [Buffer.from(text, 'utf8'), Buffer.from(`﻿${text}`, 'utf8')]
  .some((b) => b.length === e.bytes && sha256(b) === e.sha256.toLowerCase());

/** The folder's completion manifest; null when it has none; an Error when it cannot be used. */
async function readCompleteManifest(t: BucketTarget, folder: string): Promise<CompleteManifest | null | Error> {
  let text: string;
  try {
    text = await getObject(t, `${t.prefix}${folder}/${COMPLETE_MANIFEST}`);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
  try {
    const m = JSON.parse(text) as CompleteManifest;
    if (m?.version !== 1 || !Array.isArray(m.files)) return new Error(`${COMPLETE_MANIFEST} has an unknown format`);
    const files = m.files.filter((f) => f && typeof f.path === 'string' && Number.isFinite(f.bytes) && /^[0-9a-fA-F]{64}$/.test(String(f.sha256)))
      .map((f) => ({ path: f.path.replace(/\\/g, '/').replace(/^\.?\//, ''), bytes: Number(f.bytes), sha256: String(f.sha256) }));
    if (files.length !== m.files.length) return new Error(`${COMPLETE_MANIFEST} has entries without a path, size or sha256`);
    return { version: 1, createdAt: String(m.createdAt ?? ''), files };
  } catch {
    return new Error(`${COMPLETE_MANIFEST} is not valid JSON`);
  }
}

/**
 * The newest backup folder with a usable copy of the zone, and its files. A folder with a completion
 * manifest is used only when every file it lists for the zone is there and matches (size, sha256).
 * A folder without one is used, flagged unverified, only when it was made before manifests (no
 * older folder has one); otherwise it is a backup that did not finish.
 */
async function latestFolderForZone(t: BucketTarget, zoneName: string) {
  const { folders } = await listObjects(t, t.prefix, '/');
  const parsed = folders.map((f) => parseBackupFolder(f.slice(t.prefix.length).replace(/\/$/, '')))
    .filter((f): f is { name: string; time: string; partial: boolean } => !!f.time)
    .sort((a, b) => (a.time < b.time ? 1 : -1));
  if (!parsed.length) throw new HttpError(404, `No backup folders found in "${t.bucket}${t.prefix ? `/${t.prefix.replace(/\/$/, '')}` : ''}"`);
  const manifests = new Map<string, Promise<CompleteManifest | null | Error>>();
  const manifestOf = (name: string) => { if (!manifests.has(name)) manifests.set(name, readCompleteManifest(t, name)); return manifests.get(name)!; };
  const skipped: { folder: string; reason: string }[] = [];
  const skip = (folder: string, reason: string) => skipped.push({ folder, reason });
  for (const [i, f] of parsed.entries()) {
    const { keys } = await listObjects(t, `${t.prefix}${f.name}/${zoneName}/`);
    const tf = keys.filter((k) => k.key.endsWith('.tf')).map((k) => k.key);
    if (!tf.length) { skip(f.name, `no files for ${zoneName}`); continue; }
    const m = await manifestOf(f.name);
    if (m instanceof Error) { skip(f.name, `not usable: ${m.message}`); continue; }
    const base = `${t.prefix}${f.name}/`;
    if (!m) {
      // Made before completion manifests, or a backup that stopped before writing its manifest?
      let newer: string | null = null;
      for (const older of parsed.slice(i + 1, i + 1 + MANIFEST_LOOKBACK)) {
        const om = await manifestOf(older.name).catch(() => null);
        if (om) { newer = older.name; break; }
      }
      if (newer) { skip(f.name, `not usable: it has no ${COMPLETE_MANIFEST} although the older backup ${newer} has one, so this backup did not finish`); continue; }
      const files = await Promise.all(tf.map(async (k) => ({ name: k.split('/').pop()!, text: await getObject(t, k) })));
      return { folder: f, newest: parsed[0].name, skipped, files, manifest: null, verification: UNVERIFIED_NOTE };
    }
    const listed = m.files.filter((e) => e.path.startsWith(`${zoneName}/`) && e.path.endsWith('.tf'));
    if (!listed.length) { skip(f.name, `not usable: ${zoneName} has files but none is listed in its ${COMPLETE_MANIFEST}`); continue; }
    const present = new Set(tf);
    const missing = listed.filter((e) => !present.has(base + e.path));
    if (missing.length) { skip(f.name, `not usable: ${missing.length} file(s) listed in its ${COMPLETE_MANIFEST} are missing (${missing.slice(0, 3).map((e) => e.path).join(', ')}${missing.length > 3 ? ', …' : ''})`); continue; }
    // Only the files the manifest lists are used; anything else in the zone folder was not part of the finished backup.
    const files = await Promise.all(listed.map(async (e) => ({ entry: e, name: e.path.split('/').pop()!, text: await getObject(t, base + e.path) })));
    const changed = files.filter((x) => !matchesEntry(x.text, x.entry));
    if (changed.length) { skip(f.name, `not usable: ${changed.length} file(s) differ from its ${COMPLETE_MANIFEST} (${changed.slice(0, 3).map((x) => x.entry.path).join(', ')}${changed.length > 3 ? ', …' : ''})`); continue; }
    const extra = tf.length - listed.length;
    return {
      folder: f, newest: parsed[0].name, skipped, files: files.map(({ name, text }) => ({ name, text })), manifest: m,
      verification: `verified: ${listed.length} file(s) match its ${COMPLETE_MANIFEST}${extra > 0 ? ` (${extra} file(s) not listed in it were left out)` : ''}`,
    };
  }
  const unusable = skipped.filter((s) => s.reason.startsWith('not usable'));
  throw new HttpError(404, unusable.length
    ? `No usable backup of ${zoneName}: ${unusable.slice(0, 3).map((s) => `${s.folder} — ${s.reason.replace(/^not usable: /, '')}`).join('; ')}${unusable.length > 3 ? ` (and ${unusable.length - 3} more)` : ''}`
    : `None of the ${parsed.length} backup folders contains Terraform files for ${zoneName}`);
}

/** Zone-level configuration: not Zero Trust or Spectrum, and not set on the account (account_id without zone_id). */
const isZoneLevel = (b: TfBlock) => !b.type.startsWith('cloudflare_zero_trust_') && b.type !== 'cloudflare_spectrum_application' && !(/^ {2}account_id\s*=/m.test(b.text) && !/^ {2}zone_id\s*=/m.test(b.text));

export async function prepareRestore(me: Me, input: PrepareInput): Promise<RestoreView> {
  sweep();
  assertNoJob();
  if (!input?.cloudflareCredentialId || !/^[0-9a-f]{32}$/.test(input.zoneId ?? '')) throw new HttpError(400, 'Choose a Cloudflare account and zone');
  if (input.storage?.kind !== 'r2' && input.storage?.kind !== 'aws') throw new HttpError(400, 'Choose where the backups are stored (R2 or S3)');
  const cf = await credentialForRun(input.cloudflareCredentialId, 'cloudflare');
  const zone = (await listZones(cf)).find((z) => z.id === input.zoneId);
  if (!zone) throw new HttpError(404, 'That zone is not visible to this Cloudflare token');
  // Backups are read only from the account set's own storage.
  const storeCred = storageOf(cf, input.storage.kind);
  const target = await bucketTarget(storeCred, input.storage.bucket ?? '');

  const found = await latestFolderForZone(target, zone.name);
  const files = found.files;
  // The backup's own provider.tf is never used: it is code from the bucket (a provider override
  // or a data "external" block would run with the console's keys). Restores write DEFAULT_PROVIDER.
  const provider = '';
  // _backup_manifest.tf (comments only): what this backup could not capture ("# ! …" lines).
  const warnings = (files.find((f) => f.name === '_backup_manifest.tf')?.text ?? '').split(/\r?\n/)
    .filter((l) => l.startsWith('# ! ')).map((l) => l.slice(4).trim()).slice(0, 200);
  // imports.tf in an --import backup imports EVERYTHING; a restore writes its own.
  // cloudflare_email_routing_dns lists the records Email Routing needs; it cannot be imported or
  // applied (reads back empty, PATCH 404s on the apex). Email Routing on/off is restored via the API.
  // Restore covers zone-level configuration only: Zero Trust and account-level blocks are left out.
  const parsed = files.filter((f) => f.name !== 'provider.tf' && f.name !== 'imports.tf').flatMap((f) => parseBlocks(f.text, f.name));
  // Bucket content is not trusted: only literal cloudflare_* blocks reach Terraform (unsafeBlock).
  const unsafe = parsed.flatMap((b) => { const why = unsafeBlock(b); return why ? [`${b.address}: ${why}`] : []; });
  if (unsafe.length) {
    console.error(`[restore] refused ${unsafe.length} unsafe block(s) in ${found.folder.name}/${zone.name}:`, unsafe.slice(0, 20));
    await audit(me, 'security.restore_blocks_refused', zone.name, { folder: found.folder.name, blocks: unsafe.slice(0, 50) });
  }
  const blocks = parsed.filter((b) => !unsafeBlock(b) && b.type !== 'cloudflare_email_routing_dns' && isZoneLevel(b));
  const erPath = `account/api_backup/zone_${zone.name.replace(/[^a-zA-Z0-9._-]/g, '_')}/email_routing_settings.json`;
  const erEntry = found.manifest?.files.find((e) => e.path === erPath);
  const emailRouting = await getObject(target, `${target.prefix}${found.folder.name}/${erPath}`)
    .then((t) => {
      // Listed in the completion manifest but different: not trusted (Email Routing is left as it is).
      if (erEntry && !matchesEntry(t, erEntry)) { warnings.push(`${erPath} differs from the backup's ${COMPLETE_MANIFEST} — Email Routing is not restored from it`); return null; }
      const j = JSON.parse(t) as { result?: { enabled?: unknown } }; return typeof j.result?.enabled === 'boolean' ? { enabled: j.result.enabled } : null;
    })
    .catch(() => null);

  // No account ID on the credential: the zone's own account.
  const accountId = cf.fields.accountId || zone.accountId;
  const backupTime = new Date(found.folder.time);
  const oldest = new Date(Date.now() - CF_RETENTION_DAYS * DAY);
  const since = backupTime < oldest ? oldest : backupTime;
  let changes: CfChange[] = [];
  let ignored = 0;
  let ignoredEntries: RestoreView['ignoredEntries'] = [];
  let truncated = false;
  try {
    const r = await accountChanges(cf.fields.apiToken, accountId, since, new Date());
    const zoneChanges = r.changes.filter((c) => inZone(c, zone.id));
    changes = zoneChanges.filter(isConfigChange);
    ignored = zoneChanges.length - changes.length;
    ignoredEntries = zoneChanges.filter((c) => !isConfigChange(c)).slice(0, 100)
      .map((c) => ({ id: c.id, time: c.time, method: c.method, uri: c.uri.split('?')[0], actionType: c.actionType, result: c.result }));
    truncated = r.truncated;
  } catch (err) {
    throw new HttpError(502, `Reading the audit log failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
  const scope = { accountId, zoneId: zone.id };
  // Only what the backup covers: audit entries with no block in it are disregarded, except a
  // creation of a backed-up type (the comparison offers to delete it).
  const backupTypes = new Set(blocks.map((b) => b.type));
  const candidates = restoreCandidates(changes.map((c) => ({ ...c })), blocks, scope)
    .filter((c) => c.address || (c.mode === 'created-after-backup' && backupTypes.has(`cloudflare_${c.key.split(':')[1]}`)));
  // The change list shows only what the backup covers, too.
  const covered = new Set(candidates.flatMap((c) => c.changeIds));
  changes = changes.filter((c) => covered.has(c.id));

  const id = newId(9);
  const s: Session = {
    id, state: 'prepared', createdBy: me.email, createdAt: new Date().toISOString(),
    zone: { id: zone.id, name: zone.name }, account: { id: accountId, credentialId: cf.id, credentialName: cf.name },
    source: {
      kind: input.storage.kind, credentialName: storeCred.name, bucket: target.bucket, folder: found.folder.name, backupTime: found.folder.time,
      newestFolder: found.newest, skippedNewer: found.skipped.map((x) => x.folder), warnings,
      verified: !!found.manifest, verification: found.verification, skipped: found.skipped,
    },
    changes, ignored, ignoredEntries, auditTruncated: truncated, candidates,
    selected: candidates.filter((c) => c.mode === 'recreate' || (c.mode === 'revert' && c.importId)).map((c) => c.key),
    scan: null, plan: null, appliedAt: null, verified: null,
    log: [`Backup ${found.folder.name}: ${found.verification}`, ...found.skipped.filter((x) => x.reason.startsWith('not usable')).map((x) => `[WARN] Skipped the newer backup ${x.folder}: ${x.reason.replace(/^not usable: /, '')}`)],
    token: cf.fields.apiToken, provider, blocks, extras: [], dir: path.join(RESTORES_DIR, id), expires: Date.now() + SESSION_TTL,
    emailRouting, apiChanges: [], tfPlanned: false, appliedBy: null, steps: [], cancelled: null, approval: null, child: null, cancelRequested: false, keptState: null,
  };
  store.sessions.set(id, s);
  track(s, `Prepared from ${found.folder.name}, ${found.manifest ? 'verified against its completion manifest' : UNVERIFIED_NOTE} (${changes.length} change${changes.length === 1 ? '' : 's'} in the audit log since)`, me.email);
  await audit(me, 'restore.prepared', zone.name, { restoreId: id, folder: found.folder.name, bucket: target.bucket, changes: changes.length, ignored, restorable: s.selected.length, verified: !!found.manifest, skippedUnusable: found.skipped.filter((x) => x.reason.startsWith('not usable')).length });
  return view(s);
}

// ── Terraform jobs ────────────────────────────────────────────────────────────

const DEFAULT_PROVIDER = `terraform {
  required_version = ">= 1.5"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  # Auth via CLOUDFLARE_API_TOKEN (set by the console)
}
`;

/** Plans use the stored API token; every apply uses a Global API Key the approver types in. */
type CfAuth = { token: string } | { email: string; apiKey: string };

/** `guard`: plans run through the read-only proxy (CLOUDFLARE_BASE_URL), so they can never write. */
/** A Terraform CLI config that allows installing only registry.terraform.io/cloudflare/cloudflare. */
function terraformCliConfig() {
  const file = path.join(DATA_DIR, 'terraform-restore.tfrc');
  const text = `provider_installation {
  direct {
    include = ["registry.terraform.io/cloudflare/cloudflare"]
  }
}
`;
  try { if (fs.readFileSync(file, 'utf8') === text) return file; } catch { /* write it */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

async function terraformEnv(auth: CfAuth, guard?: ReadOnlyProxy) {
  const env = augmentedEnvPath({ ...process.env });
  for (const k of Object.keys(env)) if (CONSOLE_ENV_RE.test(k) || STRIP_ENV.includes(k.toUpperCase())) delete env[k];
  // GitHub Actions (the worker) sets CI=true, and cf-terraforming then skips creating its API client.
  delete env.CI;
  const settings = await getSettings();
  Object.assign(env, 'token' in auth ? { CLOUDFLARE_API_TOKEN: auth.token } : { CLOUDFLARE_EMAIL: auth.email, CLOUDFLARE_API_KEY: auth.apiKey });
  if (guard) env.CLOUDFLARE_BASE_URL = guard.baseUrl;
  Object.assign(env, {
    TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1',
    TF_PLUGIN_CACHE_DIR: settings.pluginCacheDir || path.join(DATA_DIR, 'plugin-cache'),
    // Terraform may install the Cloudflare provider and nothing else (no external, local, null …).
    TF_CLI_CONFIG_FILE: terraformCliConfig(),
  });
  fs.mkdirSync(env.TF_PLUGIN_CACHE_DIR!, { recursive: true });
  return env;
}

/** Managed resources in a terraform.tfstate, by address, with their id (only plain `type.name` addresses: restores use no modules or counts). */
function stateIds(state: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const j = JSON.parse(state) as { resources?: { mode?: string; type: string; name: string; module?: string; instances?: { index_key?: unknown; attributes?: { id?: unknown } }[] }[] };
    for (const r of j.resources ?? []) {
      if (r.mode !== 'managed' || r.module) continue;
      const inst = r.instances?.find((i) => i.index_key === undefined);
      if (inst) out.set(`${r.type}.${r.name}`, typeof inst.attributes?.id === 'string' ? inst.attributes.id : '');
    }
  } catch { /* unreadable: treated as empty */ }
  return out;
}
const stateAddresses = (state: string) => new Set(stateIds(state).keys());

/** Keeps the session's Terraform state after a failed or cancelled apply (see Session.keptState). */
function keepState(s: Session) {
  try {
    const state = fs.readFileSync(path.join(s.dir, 'terraform.tfstate'), 'utf8');
    if (stateIds(state).size) {
      s.keptState = state;
      s.log.push(`Terraform's state from this apply is kept (${stateIds(state).size} resource(s)): plan again — or compare again — and it is used, so nothing the apply already created is created twice.`);
    }
  } catch { /* no state written: nothing reached Cloudflare through Terraform */ }
}

/** Thrown inside a job once it is cancelled: the job's catch puts the restore back in a usable state. */
class Cancelled extends Error { constructor() { super('Cancelled'); } }

function tf(s: Session, bin: string, args: string[], env: NodeJS.ProcessEnv, quiet = false): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (s.cancelRequested) return Promise.reject(new Cancelled());
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: s.dir, env, windowsHide: true });
    s.child = child;
    let stdout = '';
    let stderr = '';
    const secrets = [s.token, env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_API_KEY].filter((x): x is string => !!x);
    const push = (chunk: Buffer, out: boolean) => {
      const text = secrets.reduce((t, x) => t.split(x).join('••••••••'), chunk.toString('utf8'));
      if (out) stdout += text; else stderr += text;
      if (!quiet) for (const line of text.split(/\r?\n/)) if (line.trim()) s.log.push(line);
    };
    child.stdout.on('data', (c: Buffer) => push(c, true));
    child.stderr.on('data', (c: Buffer) => push(c, false));
    const timer = setTimeout(() => { s.log.push(`[ERROR] terraform ${args[0]} timed out`); child.kill(); }, JOB_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); s.child = null; s.log.push(`[ERROR] could not start terraform: ${e.message}`); resolve({ code: -1, stdout, stderr }); });
    child.on('close', (code) => { clearTimeout(timer); s.child = null; if (s.cancelRequested) reject(new Cancelled()); else resolve({ code, stdout, stderr }); });
  });
}

async function terraformBin(s: Session) {
  await ensureTools((m) => s.log.push(m));
  const bin = resolveTools().find((t) => t.name === 'terraform')?.effective;
  if (!bin) throw new Error('terraform is not available');
  return bin;
}

interface PlanJson { resource_changes?: { address: string; type?: string; change: { actions: string[]; before: unknown; after: unknown; importing?: unknown } }[] }

function summarize(s: Session, json: PlanJson, deps: Set<string>, extra: PlannedChange[] = []) {
  const changes: PlannedChange[] = [...(json.resource_changes ?? []).map((rc) => ({
    address: rc.address,
    actions: rc.change.actions,
    importing: !!rc.change.importing,
    dependency: deps.has(rc.address),
    fields: rc.change.actions.includes('no-op') ? [] : diff(redact(rc.change.before ?? {}), redact(rc.change.after ?? {})),
  })), ...extra];
  return {
    at: new Date().toISOString(), changes,
    hasReplace: changes.some((c) => c.actions.includes('delete') && c.actions.includes('create')),
    hasDelete: changes.some((c) => c.actions.includes('delete') && !c.actions.includes('create')),
    noChanges: changes.every((c) => c.actions.every((a) => a === 'no-op' || a === 'read')),
  };
}

/** Check plan: resources still changing, ignoring attributes the provider cannot read back. */
function remainingChanges(s: Session, json: PlanJson, ignore: Map<string, Set<string>>, viaApi: Map<string, ApiMatch> = new Map()): { real: string[]; quirks: string[] } {
  const byAddr = new Map(s.blocks.map((b) => [b.address, b]));
  const real: string[] = [];
  const quirks: string[] = [];
  for (const rc of json.resource_changes ?? []) {
    if (rc.change.actions.every((a) => a === 'no-op' || a === 'read')) continue;
    // Snippets / snippet rules: the API says whether they match (the provider cannot read them).
    const api = viaApi.get(rc.address);
    if (api) { if (!api.same) real.push(`${rc.address} (${api.drift.path})`); continue; }
    // Still missing or still there: the restore did not happen.
    if (!rc.change.actions.includes('update')) { real.push(`${rc.address} (${rc.change.actions.join('+')})`); continue; }
    const b = byAddr.get(rc.address);
    if (!b) continue;
    const all = diff(redact(rc.change.before ?? {}), redact(rc.change.after ?? {})).filter((f) => setKeys(b).has(top(f.path)));
    const known = all.filter((f) => isProviderEquivalent(b.type, f) || ignore.get(rc.address)?.has(top(f.path)));
    const left = all.filter((f) => !known.includes(f));
    if (known.length) quirks.push(`${rc.address} (${[...new Set(known.map((f) => top(f.path)))].join(', ')})`);
    if (left.length) real.push(`${rc.address} (${[...new Set(left.map((f) => top(f.path)))].join(', ')})`);
  }
  return { real, quirks };
}

const top = (p: string) => p.split(/[.[]/)[0];

/**
 * Live → backup differences in attributes the backup block sets — not computed ones Cloudflare
 * fills in, and not known provider read-back quirks (PROVIDER_EQUIVALENT).
 */
function backupDrift(b: TfBlock | undefined, rc: { change: { before: unknown; after: unknown } }) {
  if (!b) return [];
  const keys = setKeys(b);
  return diff(redact(rc.change.before ?? {}), redact(rc.change.after ?? {})).filter((f) => keys.has(top(f.path)) && !isProviderEquivalent(b.type, f));
}

/** Top-level attributes a block sets (`  key = …`). */
const setKeys = (b: TfBlock) => new Set([...b.text.matchAll(/^ {2}([a-z_0-9]+)\s*=/gm)].map((m) => m[1]));

/** Writes the provider tried to send while planning (refused by the read-only guard). */
function noteBlocked(s: Session, guard: ReadOnlyProxy) {
  const uniq = [...new Set(guard.blocked)];
  if (uniq.length) s.log.push(`Read-only guard: refused ${guard.blocked.length} write(s) the Cloudflare provider tried to send while planning (${uniq.slice(0, 5).join(', ')}${uniq.length > 5 ? ', …' : ''}) — nothing was changed.`);
}

/** One job at a time across the console: a backup run or one restore job (compare, plan, apply). */
function assertNoJob() {
  const r = activeRestore();
  if (store.busy || r) throw new HttpError(409, `A restore${r ? ` of ${r.zone} (${r.job}, by ${r.by})` : ''} is running — wait for it to finish`);
  if (activeRunId()) throw new HttpError(409, 'A backup is running — wait for it to finish before restoring');
}

/** Close to the worker's time limit no apply starts (src/lib/job-lock.ts jobsPaused). */
function assertTakingJobs() {
  const paused = jobsPaused();
  if (paused) throw new HttpError(503, paused, { 'retry-after': '90' });
}

/**
 * Takes the job slot (this worker), then the account's lock row (every worker: src/lib/job-lock.ts),
 * the same one a backup of that account takes. Refused (409) while either is held.
 */
async function claim(id: string, job: ActiveRestore['job'], by: string) {
  assertNoJob();
  store.busy = id;
  const s = store.sessions.get(id);
  if (s) { s.cancelRequested = false; s.cancelled = null; }
  setActiveRestore({ id, zone: s?.zone.name ?? '', job, by, since: new Date().toISOString(), credentialId: s?.account.credentialId });
  try {
    store.lock = s ? await acquireShared([accountLockKey(s.account.id)], `restore of ${s.zone.name} (${job}, by ${by})`) : null;
  } catch (err) {
    release();
    throw err instanceof LockBusy ? new HttpError(409, err.message) : err;
  }
}

function release() {
  store.busy = null;
  setActiveRestore(null);
  void store.lock?.release();
  store.lock = null;
}

export async function planRestore(me: Me, id: string, addresses: string[]): Promise<RestoreView> {
  const s = store.sessions.get(id);
  if (!s) throw new HttpError(404, 'Restore session not found or expired — start again');
  if (s.approval) throw new HttpError(409, 'This restore is waiting for a super admin to approve the apply — withdraw the request to change the plan');
  if (s.state === 'planning' || s.state === 'applying' || s.state === 'scanning') throw new HttpError(409, 'This restore is busy');
  if (DONE(s)) throw doneError(s);
  const chosen = [...new Set(Array.isArray(addresses) ? addresses : [])];
  if (!chosen.length) throw new HttpError(400, 'Choose at least one change to restore');
  const byKey = new Map(s.candidates.map((c) => [c.key, c]));
  // Changes made through the API, not Terraform (Email Routing on/off).
  const apiChanges: ApiChange[] = [];
  const er = byKey.get(EMAIL_ROUTING_KEY);
  if (chosen.includes(EMAIL_ROUTING_KEY)) {
    if (er?.mode !== 'revert' || !s.emailRouting) throw new HttpError(400, 'Email Routing already matches the backup — compare again');
    apiChanges.push({ key: EMAIL_ROUTING_KEY, enabled: s.emailRouting.enabled });
  }
  const wanted = chosen.filter((a) => a !== EMAIL_ROUTING_KEY);
  for (const a of wanted) {
    const c = byKey.get(a);
    if (!c || !c.address || (c.mode !== 'revert' && c.mode !== 'recreate' && c.mode !== 'delete')) throw new HttpError(400, `"${a}" is not something this backup can restore`);
    if (c.mode === 'revert' && !c.importId) throw new HttpError(400, `${a} cannot be imported (${c.importSkip}) — restoring it would create a duplicate`);
    if (c.mode === 'delete' && (!c.importId || !s.extras.some((x) => x.address === c.address))) throw new HttpError(400, `${a} cannot be deleted by Terraform (${c.importSkip ?? 'compare again'})`);
  }
  // Deletes: the live object is imported into the state with no config block → the plan deletes it.
  const deletes = s.extras.filter((x) => wanted.includes(x.address));
  const keep = wanted.filter((a) => !deletes.some((x) => x.address === a));
  const blocksByAddr = new Map(s.blocks.map((b) => [b.address, b]));
  const all = withDependencies(keep, s.blocks);
  const deps = new Set(all.filter((x) => x.dependency).map((x) => x.address));
  const imports: { address: string; text: string }[] = [];
  for (const { address, dependency } of all) {
    const c = byKey.get(address);
    if (c?.mode === 'recreate') continue;
    const importId = c?.importId ?? (dependency ? importIdForDependency(s, address) : undefined);
    if (!importId) throw new HttpError(400, `${address} is referenced by a chosen block but cannot be imported`);
    imports.push({ address, text: importBlock(address, importId) });
  }

  await claim(id, 'planning', me.email);
  s.state = 'planning';
  s.selected = chosen;
  s.plan = null;
  s.apiChanges = apiChanges;
  s.tfPlanned = all.length + deletes.length > 0;
  const apiPlanned: PlannedChange[] = apiChanges.map((c) => ({
    address: EMAIL_ROUTING_LABEL, actions: ['update'], importing: false, dependency: false, api: true,
    fields: [{ path: 'enabled', old: String(!c.enabled), new: String(c.enabled) }],
  }));
  s.log = [`Backup: ${s.source.bucket}/${s.source.folder}/${s.zone.name}/ (taken ${s.source.backupTime})`,
    `Restoring ${keep.length} resource(s)${deps.size ? ` + ${deps.size} referenced resource(s)` : ''}${deletes.length ? `, deleting ${deletes.length} not in the backup` : ''}: ${[...all.map((x) => x.address), ...deletes.map((x) => x.address)].join(', ')}`];
  for (const c of apiPlanned) s.log.push(`Through the API (Terraform cannot set it): ${c.address} → ${c.fields[0].new}`);
  fs.rmSync(s.dir, { recursive: true, force: true });
  fs.mkdirSync(s.dir, { recursive: true });
  // After a failed apply, Terraform's state from it is kept: what that apply already created or
  // imported is planned from there (updated, not created a second time).
  const kept = s.keptState ? stateAddresses(s.keptState) : null;
  if (kept) {
    fs.writeFileSync(path.join(s.dir, 'terraform.tfstate'), s.keptState!, { mode: 0o600 });
    s.log.push(`Planning from the Terraform state kept from the failed apply (${kept.size} resource(s) in it), so nothing it already created is created again.`);
  }
  // Already in the kept state: not imported again.
  const importsText = () => imports.filter((x) => !kept?.has(x.address)).map((x) => x.text).join('\n');
  fs.writeFileSync(path.join(s.dir, 'provider.tf'), DEFAULT_PROVIDER);
  fs.writeFileSync(path.join(s.dir, 'restore.tf'), `${all.map((x) => blocksByAddr.get(x.address)!.text).join('\n\n')}\n`);
  // With deletes, imports.tf is written after those are imported into the state (below).
  if (deletes.length) fs.writeFileSync(path.join(s.dir, 'extras.tf'), `${deletes.map((x) => x.text).join('\n\n')}\n`);
  else fs.writeFileSync(path.join(s.dir, 'imports.tf'), importsText());
  track(s, `Plan started (${all.length} resource${all.length === 1 ? '' : 's'})`, me.email);
  await audit(me, 'restore.planned', s.zone.name, { restoreId: s.id, folder: s.source.folder, resources: all.map((x) => x.address), deletes: deletes.map((x) => x.address) });

  void (async () => {
    const guard = await startReadOnlyProxy();
    try {
      if (!s.tfPlanned) {
        s.plan = summarize(s, {}, deps, apiPlanned);
        s.state = 'planned';
        s.log.push(`Plan ready: ${apiPlanned.length} change(s). Review it, then apply.`);
        return;
      }
      const bin = await terraformBin(s);
      const env = await terraformEnv({ token: s.token }, guard);
      if ((await tf(s, bin, ['init', '-input=false', '-no-color'], env)).code !== 0) throw new Error('terraform init failed');
      if (kept) {
        // In the kept state but not chosen now: forgotten (state rm), never deleted from Cloudflare.
        const planned = new Set([...all.map((x) => x.address), ...deletes.map((x) => x.address)]);
        for (const addr of [...kept].filter((a) => !planned.has(a))) {
          const r = await tf(s, bin, ['state', 'rm', '-no-color', addr], env, true);
          if (r.code !== 0) throw new Error(`terraform state rm ${addr} failed — compare again to start from the live zone`);
          s.log.push(`${addr} (from the failed apply) is not chosen now: left as it is in Cloudflare.`);
        }
      }
      // Into the state only (read-only); with their blocks then removed, the plan deletes them.
      const scope = { accountId: s.account.id, zoneId: s.zone.id };
      for (const x of deletes) {
        if (kept?.has(x.address)) { s.log.push(`Will delete ${x.address} (not in the backup)`); continue; }
        const r = await tf(s, bin, ['import', '-input=false', '-no-color', x.address, importIdFor(x, scope).id!], env, true);
        s.log.push(r.code === 0 ? `Will delete ${x.address} (not in the backup)` : `[WARN] ${x.address} could not be imported — it may be gone already; not deleted`);
      }
      if (deletes.length) {
        fs.rmSync(path.join(s.dir, 'extras.tf'), { force: true });
        fs.writeFileSync(path.join(s.dir, 'imports.tf'), importsText());
      }
      if ((await tf(s, bin, ['plan', '-input=false', '-no-color', '-out=tfplan'], env)).code !== 0) throw new Error('terraform plan failed');
      const shown = await tf(s, bin, ['show', '-json', 'tfplan'], env, true);
      if (shown.code !== 0) throw new Error('terraform show failed');
      s.plan = summarize(s, JSON.parse(shown.stdout) as PlanJson, deps, apiPlanned);
      s.state = 'planned';
      s.log.push(`Plan ready: ${s.plan.changes.filter((c) => !c.actions.includes('no-op')).length} change(s). Review it, then apply.`);
    } catch (err) {
      if (s.cancelRequested) {
        s.plan = null;
        s.state = s.scan ? 'scanned' : 'prepared';
        s.log.push(`[CANCELLED] Planning was cancelled by ${s.cancelled?.by ?? 'someone'} — nothing was changed. Choose what to restore and plan again.`);
      } else {
        s.state = 'plan-failed';
        s.log.push(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      // Released before the state is seen as done, so the next step is never refused as busy.
      noteBlocked(s, guard);
      release();
      await guard.close();
      s.expires = Date.now() + SESSION_TTL;
      track(s, s.state === 'planned' ? `Planned: ${s.plan?.changes.filter((c) => !c.actions.includes('no-op')).length ?? 0} change(s) to review` : s.cancelRequested ? 'Plan cancelled' : 'Plan failed', s.cancelled?.by ?? me.email);
      // Terraform found nothing to change: the zone already matches the backup, so the restore is done.
      if (s.state === 'planned' && s.plan?.noChanges && !s.cancelRequested) {
        s.state = 'matched';
        await complete(me, s, 'plan');
      }
    }
  })();
  return view(s);
}

// ── Compare everything ─────────────────────────────────────────────────────────

const COMPARE_ROUNDS = 6;
// cf-terraforming reports "nothing configured / not on this plan" as errors too (same rules as backup.js).
const GEN_ERR_RE = /level=(error|fatal)|failed to fetch|error getting API response|unsupported resource type/;
const GEN_BENIGN_RE = /404|[Nn]ot [Ff]ound|no result found|has not been enabled|[Nn]ot enabled|not available for your plan/;

/** Runs a tool in the session dir and keeps stdout + stderr (secrets masked). */
function capture(s: Session, bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const secrets = [s.token, env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_API_KEY].filter((x): x is string => !!x);
  const mask = (t: string) => secrets.reduce((a, x) => a.split(x).join('••••••••'), t);
  if (s.cancelRequested) return Promise.reject(new Cancelled());
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: s.dir, env, windowsHide: true });
    s.child = child;
    let stdout = '', stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.on('error', (e) => { clearTimeout(timer); s.child = null; resolve({ code: -1, stdout: '', stderr: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); s.child = null; if (s.cancelRequested) reject(new Cancelled()); else resolve({ code, stdout: mask(stdout), stderr: mask(stderr) }); });
  });
}

/**
 * Everything live in the zone, as Terraform blocks: cf-terraforming for each zone type (like the
 * backup), and the rulesets API for rulesets. `listed` holds the types that could be read.
 */
async function listLive(s: Session, tfBin: string, env: NodeJS.ProcessEnv, types: string[]) {
  const blocks: TfBlock[] = [];
  const listed = new Set<string>();
  const failed: string[] = [];
  const cft = resolveTools().find((t) => t.name === 'cf-terraforming')?.effective;
  for (const type of types.filter((t) => t !== 'cloudflare_ruleset' && t !== 'cloudflare_access_rule')) {
    if (!cft) { failed.push(type); continue; }
    const r = await capture(s, cft, ['generate', '--resource-type', type, '--zone', s.zone.id, '--terraform-binary-path', tfBin, '--terraform-install-path', s.dir], env);
    const errs = r.stderr.split('\n').filter((l) => GEN_ERR_RE.test(l));
    if (errs.length && errs.every((l) => GEN_BENIGN_RE.test(l))) { listed.add(type); continue; } // not configured / not on this plan
    if (r.code !== 0 || errs.length) { failed.push(type); continue; }
    listed.add(type);
    blocks.push(...parseBlocks(r.stdout, `live:${type}`));
  }
  // Rulesets: the zone's own (kind "zone") phase entrypoints. Managed rulesets belong to Cloudflare.
  try {
    let cursor = '';
    for (let page = 0; page < 50; page++) {
      const res = await fetch(`${CF_API}/zones/${s.zone.id}/rulesets${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: { Authorization: `Bearer ${s.token}` }, signal: AbortSignal.timeout(30_000), cache: 'no-store' });
      const body = (await res.json().catch(() => null)) as { success?: boolean; result?: { id: string; name?: string; kind?: string; phase?: string }[]; result_info?: { cursor?: string } } | null;
      if (!res.ok || !body?.success) throw new Error(`HTTP ${res.status}`);
      for (const r of body.result ?? []) {
        if (r.kind !== 'zone' || !r.id || !r.phase) continue;
        blocks.push(...parseBlocks(`resource "cloudflare_ruleset" "terraform_managed_resource_${r.id}_0" {\n  kind    = "zone"\n  name    = ${JSON.stringify(r.name || 'default')}\n  phase   = ${JSON.stringify(r.phase)}\n  zone_id = "${s.zone.id}"\n}\n`, 'live:cloudflare_ruleset'));
      }
      cursor = body.result_info?.cursor ?? '';
      if (!cursor) break;
    }
    listed.add('cloudflare_ruleset');
  } catch (err) {
    console.error('[restore] listing rulesets failed:', err instanceof Error ? err.message : err);
    failed.push('cloudflare_ruleset');
  }
  // IP Access rules: only zone-level ones (the zone list also returns account / user rules).
  try {
    for (let page = 1; page <= 200; page++) {
      const res = await fetch(`${CF_API}/zones/${s.zone.id}/firewall/access_rules/rules?per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${s.token}` }, signal: AbortSignal.timeout(30_000), cache: 'no-store' });
      const body = (await res.json().catch(() => null)) as { success?: boolean; result?: { id: string; mode?: string; scope?: { type?: string }; configuration?: { target?: string; value?: string } }[]; result_info?: { total_pages?: number } } | null;
      if (!res.ok || !body?.success) throw new Error(`HTTP ${res.status}`);
      for (const r of body.result ?? []) {
        if (r.scope?.type !== 'zone' || !r.id || !r.mode || !r.configuration?.target) continue;
        blocks.push(...parseBlocks(`resource "cloudflare_access_rule" "terraform_managed_resource_${r.id}_0" {\n  mode    = ${JSON.stringify(r.mode)}\n  configuration = {\n    target = ${JSON.stringify(r.configuration.target)}\n    value  = ${JSON.stringify(r.configuration.value ?? '')}\n  }\n  zone_id = "${s.zone.id}"\n}\n`, 'live:cloudflare_access_rule'));
      }
      if (!body.result?.length || page >= (body.result_info?.total_pages ?? 1)) break;
    }
    listed.add('cloudflare_access_rule');
  } catch (err) {
    console.error('[restore] listing IP Access rules failed:', err instanceof Error ? err.message : err);
    failed.push('cloudflare_access_rule');
  }
  return { blocks, listed, failed };
}

/**
 * Makes the live zone comparable with the backup, resource by resource (read-only: nothing is
 * written to Cloudflare). Every block of the backup is imported and planned, so each one shows as
 * differs / deleted / matches — whatever the audit log says. The live zone is also listed (the same
 * resource types the backup exports): anything live the backup does not have is offered for
 * deletion, so a restore can put the zone back exactly as it was. Imports of objects that no longer
 * exist fail; those are switched to "re-create" and the plan runs again.
 */
export async function compareRestore(me: Me, id: string): Promise<RestoreView> {
  const s = store.sessions.get(id);
  if (!s) throw new HttpError(404, 'Restore session not found or expired — start again');
  if (s.approval) throw new HttpError(409, 'This restore is waiting for a super admin to approve the apply — withdraw the request first');
  if (s.state === 'planning' || s.state === 'applying' || s.state === 'scanning') throw new HttpError(409, 'This restore is busy');
  if (DONE(s)) throw doneError(s);
  if (!s.blocks.length) throw new HttpError(400, 'The backup has no resource blocks for this zone');
  await claim(id, 'comparing', me.email);
  s.state = 'scanning';
  s.plan = null;
  s.scan = null;
  s.log = [`Comparing the live zone with all ${s.blocks.length} resource(s) in ${s.source.folder}/${s.zone.name}/ (read-only) …`];
  track(s, `Compare everything started (${s.blocks.length} resources in the backup)`, me.email);
  await audit(me, 'restore.compared', s.zone.name, { restoreId: s.id, folder: s.source.folder, resources: s.blocks.length });

  void (async () => {
    const guard = await startReadOnlyProxy();
    try {
      const bin = await terraformBin(s);
      const env = await terraformEnv({ token: s.token }, guard);
      const scope = { accountId: s.account.id, zoneId: s.zone.id };
      const blocksByAddr = new Map(s.blocks.map((b) => [b.address, b]));
      const audited = new Map(s.candidates.map((c) => [c.key, c]));
      const excluded = new Map<string, string>(); // address → why it cannot be checked
      const missing = new Set<string>();
      const importIds = new Map<string, string>();
      // A failed apply's kept state: objects it created again under a new ID are compared as they are now.
      const kept = s.keptState ? stateIds(s.keptState) : new Map<string, string>();
      const keptAs = new Map<string, string>();
      for (const b of s.blocks) {
        const known = audited.get(b.address);
        const keptId = kept.get(b.address);
        if (keptId && keptId !== b.labelId && !SKIP_IMPORT[b.type]) {
          const imp = importIdFor({ type: b.type, labelId: keptId, attrs: { ...b.attrs, id: '' } }, scope);
          if (imp.id) { importIds.set(b.address, imp.id); keptAs.set(b.address, keptId); continue; }
        }
        // Deleted per the audit log, or written back by create (SKIP_IMPORT: snippets): planned without import.
        if (known?.mode === 'recreate' || SKIP_IMPORT[b.type]) { missing.add(b.address); continue; }
        const imp = known?.importId ? { id: known.importId } : importIdFor(b, scope);
        if (imp.id) importIds.set(b.address, imp.id);
        else excluded.set(b.address, `cannot be imported to compare (${imp.skip})`);
      }
      fs.rmSync(s.dir, { recursive: true, force: true });
      fs.mkdirSync(s.dir, { recursive: true });
      fs.writeFileSync(path.join(s.dir, 'provider.tf'), DEFAULT_PROVIDER);
      if ((await tf(s, bin, ['init', '-input=false', '-no-color'], env)).code !== 0) throw new Error('terraform init failed');

      // 1. What is live that the backup does not have.
      const backupTypes = new Set(s.blocks.map((b) => b.type));
      // The types the backup enumerates per zone (per-ID types such as zone settings cannot be listed, and are singletons).
      const liveTypes = [...LIVE_ZONE_TYPES, 'cloudflare_ruleset', 'cloudflare_access_rule'].filter((t) => backupTypes.has(t));
      s.log.push(`Listing the live zone (${liveTypes.length} resource types) …`);
      const live = await listLive(s, bin, env, liveTypes);
      // What the backup does not cover is disregarded: only types it has are listed, checked and reverted.
      live.failed = live.failed.filter((t) => backupTypes.has(t));
      if (live.failed.length) s.log.push(`  [WARN] could not list ${live.failed.length} type(s): ${live.failed.join(', ')}`);
      // A backup object the audit log saw deleted and created again is compared under its new ID: not extra.
      const remade = new Set(s.blocks.flatMap((b) => { const r = keptAs.get(b.address) ?? audited.get(b.address)?.recreatedAs; return r ? [`${b.type}|${r}`] : []; }));
      if (keptAs.size) s.log.push(`  ${keptAs.size} resource(s) the failed apply created again are compared under their new ID (from its kept Terraform state).`);
      let extras = liveExtras(s.blocks, live.blocks, scope).filter((l) => backupTypes.has(l.type) && !remade.has(`${l.type}|${l.labelId}`));
      s.log.push(`  ${live.blocks.length} live resource(s) listed, ${extras.length} not in the backup.`);

      // 2. Import + plan every backup block; imports of deleted objects fail → re-create.
      const reusedAs = new Map<string, string>(keptAs);
      const reusedLive = new Set<string>();
      /** Plans only `set` (imported) plus what it references (created): the errors of those imports alone. */
      const trial = async (set: TfBlock[]) => {
        const conf = layout(withDependencies(set.map((b) => b.address), s.blocks).filter((x) => !excluded.has(x.address)).map((x) => ({ address: x.address, text: blocksByAddr.get(x.address)!.text })), 'restore.tf');
        const imps = layout(set.map((b) => ({ address: b.address, text: importBlock(b.address, importIds.get(b.address)!) })), 'imports.tf');
        fs.writeFileSync(path.join(s.dir, 'restore.tf'), conf.text);
        fs.writeFileSync(path.join(s.dir, 'imports.tf'), imps.text);
        const run = await tf(s, bin, ['plan', '-input=false', '-no-color', '-json'], env, true);
        return run.code === 0 ? [] : planErrors(run.stdout, [...conf.ranges, ...imps.ranges], new Map(set.map((b) => [b.address, importIds.get(b.address)!])));
      };
      /**
       * An error that names no resource (a provider error with only a URL): halves the imports until
       * the ones that fail on their own are found, so one odd error never stops the whole comparison.
       */
      const isolate = async (set: TfBlock[]): Promise<PlanError[]> => {
        const errors = await trial(set);
        if (!errors.length) return [];
        const named = errors.filter((e) => e.address && set.some((b) => b.address === e.address));
        if (named.length) return named;
        if (set.length === 1) return [{ ...errors[0], address: set[0].address }];
        const mid = Math.ceil(set.length / 2);
        return [...await isolate(set.slice(0, mid)), ...await isolate(set.slice(mid))];
      };
      const planAll = async (): Promise<PlanJson | null> => {
        // Each round settles at least one resource, so it always ends; the cap only guards against a loop.
        for (let round = 1; round <= s.blocks.length + COMPARE_ROUNDS; round++) {
          for (const a of dependents(new Set(excluded.keys()), s.blocks)) if (!excluded.has(a)) excluded.set(a, 'references a resource that could not be checked');
          const active = s.blocks.filter((b) => !excluded.has(b.address));
          if (!active.length) return null;
          const conf = layout(active.map((b) => ({ address: b.address, text: b.text })), 'restore.tf');
          const toImport = active.filter((b) => !missing.has(b.address));
          const imps = layout(toImport.map((b) => ({ address: b.address, text: importBlock(b.address, importIds.get(b.address)!) })), 'imports.tf');
          fs.writeFileSync(path.join(s.dir, 'restore.tf'), conf.text);
          fs.writeFileSync(path.join(s.dir, 'imports.tf'), imps.text);
          s.log.push(`Planning ${active.length} resource(s), importing ${toImport.length} …`);
          const run = await tf(s, bin, ['plan', '-input=false', '-no-color', '-json', '-out=tfplan'], env, true);
          if (run.code === 0) {
            const shown = await tf(s, bin, ['show', '-json', 'tfplan'], env, true);
            if (shown.code !== 0) throw new Error('terraform show failed');
            return JSON.parse(shown.stdout) as PlanJson;
          }
          let errors = planErrors(run.stdout, [...conf.ranges, ...imps.ranges], new Map(toImport.map((b) => [b.address, importIds.get(b.address)!])));
          if (!errors.some((e) => e.address && blocksByAddr.has(e.address) && !excluded.has(e.address)) && toImport.length) {
            for (const e of errors.slice(0, 3)) s.log.push(`  [WARN] ${e.message}`);
            s.log.push(`  That error names no resource — narrowing it down among ${toImport.length} import(s) …`);
            errors = await isolate(toImport);
          }
          let progressed = false;
          for (const e of errors) {
            if (!e.address || excluded.has(e.address) || !blocksByAddr.has(e.address)) continue;
            if (e.missing && !missing.has(e.address) && importIds.has(e.address)) {
              missing.add(e.address);
              s.log.push(`  deleted live: ${e.address}`);
            } else {
              excluded.set(e.address, e.message);
              s.log.push(`  [WARN] cannot check ${e.address}: ${e.message}`);
            }
            progressed = true;
          }
          if (!progressed) {
            for (const e of errors.slice(0, 5)) s.log.push(`[ERROR] ${e.message}`);
            throw new Error('terraform plan failed for a reason not tied to one resource — see above');
          }
        }
        throw new Error('The comparison did not finish — see the warnings above');
      };
      let json = await planAll();
      // 3. A deleted backup object created again under a new ID: import that one as the backup block.
      const reused = reusedExtras([...missing].map((a) => blocksByAddr.get(a)!).filter((b) => !reusedAs.has(b.address)), extras);
      for (const [addr, l] of reused) {
        const b = blocksByAddr.get(addr)!;
        const imp = importIdFor({ type: b.type, labelId: l.labelId, attrs: { ...b.attrs, id: '' } }, scope);
        if (!imp.id) continue;
        importIds.set(addr, imp.id);
        missing.delete(addr);
        reusedAs.set(addr, l.labelId);
        reusedLive.add(l.address);
        s.log.push(`  ${addr} was created again as ${l.labelId} — comparing that object instead`);
      }
      if (reusedAs.size) {
        extras = extras.filter((l) => !reusedLive.has(l.address));
        json = await planAll();
      }
      if (!json) throw new Error('None of the backup resources could be compared');

      // 4. Candidates: the comparison decides each mode; audit entries stay attached.
      const byAddr = new Map((json.resource_changes ?? []).map((rc) => [rc.address, rc]));
      const auditOnly = s.candidates.filter((c) => !c.address);
      const next: Session['candidates'] = [];
      let differs = 0, gone = 0, same = 0;
      // Snippets and snippet rules: the provider cannot read them (snippet import crashes, rules
      // read back empty), so they are compared with the live zone through the API instead.
      const viaApi = await snippetsMatch(s, { Authorization: `Bearer ${s.token}` }, json);
      for (const b of s.blocks) {
        const prev = audited.get(b.address);
        const c: RestoreCandidate = prev ? { ...prev } : { key: b.address, address: b.address, type: b.type, mode: 'matches', changeIds: [], lastAction: '', lastTime: '' };
        c.found = 'compare';
        delete c.drift;
        delete c.reason;
        if (reusedAs.has(b.address)) c.recreatedAs = reusedAs.get(b.address);
        const rc = byAddr.get(b.address);
        const api = viaApi.get(b.address);
        if (api && rc && !excluded.has(b.address)) {
          // Snippets are always written with create (PUT, overwrites in place); rules are imported.
          const mode = b.type === 'cloudflare_snippet' ? 'recreate' : 'revert';
          if (api.same) {
            Object.assign(c, { mode: 'matches', importId: importIds.get(b.address) });
            same++;
          } else {
            Object.assign(c, { mode, importId: mode === 'revert' ? importIds.get(b.address) : undefined, importSkip: undefined, drift: [api.drift] });
            if (api.missing) gone++; else differs++;
          }
        } else if (excluded.has(b.address) || !rc) {
          Object.assign(c, { mode: 'unchecked', reason: excluded.get(b.address) ?? 'not in the plan' });
        } else if (rc.change.actions.includes('create') && !rc.change.actions.includes('delete')) {
          Object.assign(c, { mode: 'recreate', importId: undefined, importSkip: undefined });
          gone++;
        } else if (rc.change.actions.every((a) => a === 'no-op' || a === 'read')) {
          Object.assign(c, { mode: 'matches', importId: importIds.get(b.address) });
          same++;
        } else {
          // Only attributes the backup block sets — not computed ones (editable, modified_on …) —
          // and not ones the provider cannot round-trip. Nothing left: it matches the backup.
          const drift = backupDrift(b, rc);
          if (drift.length) {
            Object.assign(c, { mode: 'revert', importId: importIds.get(b.address), importSkip: undefined, drift: drift.slice(0, 40) });
            differs++;
          } else {
            Object.assign(c, { mode: 'matches', importId: importIds.get(b.address) });
            same++;
          }
        }
        next.push(c);
      }
      // Live, not in the backup → delete (the audit entry that created it, if any, is attached).
      const used = new Set(s.blocks.map((b) => b.address));
      s.extras = extras.map((l) => asExtra(l, used));
      for (const x of s.extras) {
        const created = auditOnly.find((a) => a.key.endsWith(`:${x.labelId}`));
        const imp = importIdFor(x, scope);
        next.push({
          key: x.address, address: x.address, type: x.type, mode: 'delete', found: 'compare', typeInBackup: backupTypes.has(x.type),
          importId: imp.id, importSkip: imp.skip, changeIds: created?.changeIds ?? [], lastAction: created?.lastAction ?? '', lastTime: created?.lastTime ?? '',
        });
      }
      // Email Routing on/off (not Terraform): the backup's API snapshot vs the live zone.
      if (s.emailRouting) {
        const live = await liveEmailRouting(s.zone.id, { Authorization: `Bearer ${s.token}` }).catch((err: Error) => err);
        const base = { key: EMAIL_ROUTING_KEY, address: EMAIL_ROUTING_LABEL, type: 'cloudflare_email_routing', found: 'compare' as const, changeIds: [], lastAction: '', lastTime: '' };
        if (live instanceof Error) {
          next.push({ ...base, mode: 'unchecked', reason: `could not read Email Routing: ${live.message}` });
        } else if (live === s.emailRouting.enabled) {
          next.push({ ...base, mode: 'matches' });
          same++;
        } else {
          next.push({ ...base, mode: 'revert', importId: `zones/${s.zone.id}/email/routing`, drift: [{ path: 'enabled', old: String(live), new: String(s.emailRouting.enabled) }] });
          differs++;
        }
      }
      // Audit-only entries (no block in the backup) are not backed up: disregarded. A creation of a
      // backed-up type is the delete above, with its audit entry attached.
      s.candidates = next;
      s.selected = next.filter((c) => c.mode === 'recreate' || ((c.mode === 'revert' || (c.mode === 'delete' && c.typeInBackup)) && c.importId)).map((c) => c.key);
      const unchecked = next.filter((c) => c.mode === 'unchecked').length;
      s.scan = { at: new Date().toISOString(), total: s.blocks.length, differs, missing: gone, matches: same, unchecked, extra: s.extras.length, listFailed: live.failed };
      s.log.push(`Compared: ${differs} differ from the backup, ${gone} deleted, ${s.extras.length} not in the backup (to delete), ${same} match, ${unchecked} could not be checked.`);
      // The comparison now knows those objects by their live IDs: the next plan imports them from there.
      s.keptState = null;
    } catch (err) {
      if (s.cancelRequested) {
        s.scan = null;
        s.log.push(`[CANCELLED] The comparison was cancelled by ${s.cancelled?.by ?? 'someone'} — nothing was changed.`);
      } else {
        const error = err instanceof Error ? err.message : String(err);
        s.scan = { at: new Date().toISOString(), total: s.blocks.length, differs: 0, missing: 0, matches: 0, unchecked: 0, extra: 0, listFailed: [], error };
        s.log.push(`[ERROR] ${error}`);
      }
    } finally {
      noteBlocked(s, guard);
      s.state = s.scan ? 'scanned' : 'prepared';
      const matched = !s.cancelRequested && matchesBackup(s);
      if (matched) s.state = 'matched';
      release();
      await guard.close();
      s.expires = Date.now() + SESSION_TTL;
      track(s, s.cancelRequested ? 'Compare cancelled' : s.scan?.error ? 'Compare failed' : `Compared: ${s.scan?.differs ?? 0} differ, ${s.scan?.missing ?? 0} deleted, ${s.scan?.extra ?? 0} not in the backup`, me.email);
      if (matched) await complete(me, s, 'compare');
    }
  })();
  return view(s);
}

/**
 * The comparison found nothing to restore: no differences, deletions or extras, and every resource
 * could be checked (an unchecked resource or a type that could not be listed leaves the restore open).
 */
function matchesBackup(s: Session) {
  const sc = s.scan;
  return !!sc && !sc.error && !sc.unchecked && !sc.listFailed.length
    && !s.candidates.some((c) => c.mode === 'revert' || c.mode === 'recreate' || c.mode === 'delete' || c.mode === 'unchecked');
}

/** Closes a restore whose zone already matches the backup: nothing is applied, and it cannot be planned or applied any more. */
async function complete(me: Me, s: Session, by: 'compare' | 'plan') {
  s.log.push(by === 'compare'
    ? `Completed: the live zone matches the backup (${s.scan?.matches ?? 0} resource(s) checked), so there is nothing to restore.`
    : 'Completed: Terraform found nothing to change. The live zone already matches the backup.');
  track(s, 'Completed: the live zone matches the backup, nothing to restore', me.email);
  await audit(me, 'restore.completed', s.zone.name, { restoreId: s.id, folder: s.source.folder, result: 'matches_backup', by });
}

/** A referenced (not chosen) block must already exist live, so it is imported, never created. */
function importIdForDependency(s: Session, address: string) {
  const b = s.blocks.find((x) => x.address === address);
  return b ? importIdFor(b, { accountId: s.account.id, zoneId: s.zone.id }).id : undefined;
}

const CF_API = 'https://api.cloudflare.com/client/v4';

/** A multipart/form-data body → file name → content (snippet content comes back like this). */
function multipartFiles(body: string, contentType: string): Map<string, string> {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  const files = new Map<string, string>();
  if (!boundary) return files;
  for (const part of body.split(`--${boundary}`)) {
    const at = part.indexOf('\r\n\r\n');
    if (at < 0) continue;
    const head = part.slice(0, at);
    const name = /filename="([^"]*)"/i.exec(head)?.[1] ?? /name="([^"]*)"/i.exec(head)?.[1];
    if (name) files.set(name, part.slice(at + 4).replace(/\r\n$/, ''));
  }
  return files;
}

type ApiMatch = { same: boolean; missing?: boolean; drift: { path: string; old?: string; new?: string } };

/**
 * Snippets and snippet rules compared with the live zone through the API, from the backup values
 * in the plan (`after`). The provider cannot read them back. A lookup that fails is left out, so
 * the provider's own result is used for it.
 */
async function snippetsMatch(s: Session, auth: Record<string, string>, json: PlanJson): Promise<Map<string, ApiMatch>> {
  const out = new Map<string, ApiMatch>();
  const get = (p: string) => fetch(`${CF_API}/zones/${s.zone.id}${p}`, { headers: auth, signal: AbortSignal.timeout(30_000), cache: 'no-store' });
  for (const rc of json.resource_changes ?? []) {
    const after = (rc.change.after ?? {}) as { snippet_name?: string; files?: { name?: string; content?: string }[]; rules?: { snippet_name?: string; expression?: string; enabled?: boolean; description?: string }[] | null };
    try {
      if (rc.type === 'cloudflare_snippet' && after.snippet_name) {
        const res = await get(`/snippets/${encodeURIComponent(after.snippet_name)}/content`);
        if (res.status === 404) { out.set(rc.address, { same: false, missing: true, drift: { path: 'snippet', old: '(not in the live zone)', new: after.snippet_name } }); continue; }
        if (!res.ok) continue;
        const live = multipartFiles(await res.text(), res.headers.get('content-type') ?? '');
        const differ = (after.files ?? []).filter((f) => live.get(f.name ?? '') !== f.content).map((f) => f.name);
        out.set(rc.address, { same: differ.length === 0 && live.size === (after.files ?? []).length, drift: { path: 'files', old: `live code differs (${differ.join(', ') || 'file list'})`, new: 'backup code' } });
      } else if (rc.type === 'cloudflare_snippet_rules') {
        const res = await get('/snippets/snippet_rules');
        const body = (await res.json().catch(() => null)) as { success?: boolean; result?: unknown } | null;
        if (!res.ok || !body?.success) continue;
        const list = (Array.isArray(body.result) ? body.result : (body.result as { rules?: unknown[] } | null)?.rules ?? []) as typeof after.rules;
        const norm = (l: typeof after.rules) => JSON.stringify((l ?? []).map((r) => ({ snippet_name: r.snippet_name ?? '', expression: r.expression ?? '', enabled: !!r.enabled, description: r.description ?? '' })));
        const same = norm(list) === norm(after.rules);
        out.set(rc.address, { same, drift: { path: 'rules', old: `${(list ?? []).length} live rule(s)`, new: `${(after.rules ?? []).length} in the backup` } });
      }
    } catch { /* lookup failed: the provider's result stands */ }
  }
  return out;
}

/** Is Email Routing enabled on the zone? */
async function liveEmailRouting(zoneId: string, auth: Record<string, string>): Promise<boolean> {
  const res = await fetch(`${CF_API}/zones/${zoneId}/email/routing`, { headers: auth, signal: AbortSignal.timeout(20_000), cache: 'no-store' });
  const body = (await res.json().catch(() => null)) as { success?: boolean; result?: { enabled?: boolean }; errors?: { message?: string }[] } | null;
  if (!res.ok || !body?.success) throw new Error(body?.errors?.[0]?.message ?? `HTTP ${res.status}`);
  return body.result?.enabled === true;
}

/** Turns Email Routing on (Cloudflare adds its MX / TXT records) or off (removes them). */
async function setEmailRouting(s: Session, enabled: boolean, auth: Record<string, string>) {
  const res = await fetch(`${CF_API}/zones/${s.zone.id}/email/routing/dns`, {
    method: enabled ? 'POST' : 'DELETE', headers: { ...auth, 'Content-Type': 'application/json' },
    body: enabled ? JSON.stringify({ name: s.zone.name }) : undefined, signal: AbortSignal.timeout(30_000), cache: 'no-store',
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean; errors?: { code?: number; message?: string }[] } | null;
  if (!res.ok || !body?.success) throw new Error(`${enabled ? 'Enabling' : 'Disabling'} Email Routing failed: ${body?.errors?.map((e) => `${e.message} (${e.code})`).join('; ') || `HTTP ${res.status}`}`);
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const GLOBAL_KEY_RE = /^[0-9A-Za-z]{30,64}$/;

/** The typed-in email + Global API Key must be valid and reach this zone in this account. */
async function checkGlobalKey(s: Session, email: string, apiKey: string) {
  let res: Response;
  try {
    res = await fetch(`${CF_API}/zones/${s.zone.id}`, { headers: { 'X-Auth-Email': email, 'X-Auth-Key': apiKey }, signal: AbortSignal.timeout(20_000), cache: 'no-store' });
  } catch {
    throw new HttpError(502, 'Could not reach the Cloudflare API to check the Global API Key');
  }
  const body = (await res.json().catch(() => null)) as { success?: boolean; result?: { id?: string; account?: { id?: string } } } | null;
  if (res.status === 400 || res.status === 401 || res.status === 403 || (!body?.success && res.status < 500)) {
    throw new HttpError(400, 'Cloudflare did not accept that email and Global API Key for this zone');
  }
  if (!res.ok || !body?.success) throw new HttpError(502, `Cloudflare answered HTTP ${res.status} while checking the Global API Key`);
  if (body.result?.id !== s.zone.id || (body.result?.account?.id && body.result.account.id !== s.account.id)) {
    throw new HttpError(400, `That Global API Key's user cannot reach ${s.zone.name} in this account`);
  }
}

export async function applyRestore(me: Me, id: string, input: { confirm?: string; acknowledgeReplace?: boolean; email?: string; apiKey?: string; reason?: string; ticket?: string }): Promise<RestoreView> {
  const s = store.sessions.get(id);
  if (!s) throw new HttpError(404, 'Restore session not found or expired — start again');
  if (s.state !== 'planned' || !s.plan) throw new HttpError(409, 'Make a plan first');
  if (Date.now() - Date.parse(s.plan.at) > PLAN_MAX_AGE_MS) throw new HttpError(409, 'The plan is older than 30 minutes — make a new plan so it reflects the live zone');
  if (s.plan.noChanges) throw new HttpError(409, 'The plan has no changes — the zone already matches the backup');
  if ((input?.confirm ?? '').trim().toLowerCase() !== s.zone.name.toLowerCase()) throw new HttpError(400, `Type the zone name (${s.zone.name}) to confirm`);
  if ((s.plan.hasReplace || s.plan.hasDelete) && input.acknowledgeReplace !== true) throw new HttpError(400, 'This plan replaces or deletes resources — confirm that explicitly');
  // Asked for at every apply; used for this one Terraform run only — never stored, logged or returned.
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!EMAIL_RE.test(email) || !GLOBAL_KEY_RE.test(apiKey)) throw new HttpError(400, 'Enter the Cloudflare account email and its Global API Key to apply');
  if (s.approval) throw new HttpError(409, 'This restore is already waiting for a super admin to approve the apply');
  const direct = can(me.role, 'restore:approve');
  if (direct) { assertNoJob(); assertTakingJobs(); }
  // A request carries its reason and ticket to the approver (checked before the key is).
  const note = direct ? {} : await requestNote(input);
  await checkGlobalKey(s, email, apiKey);
  if (s.state !== 'planned' || s.approval) throw new HttpError(409, 'This restore changed while the key was being checked — reload');
  if (!direct) return requestApply(me, s, email, apiKey, note);
  return startApply(s, me, email, apiKey);
}

/** An admin's apply: held until a super admin approves it (the key stays in memory only). */
async function requestApply(me: Me, s: Session, email: string, apiKey: string, note: ChangeNote = {}): Promise<RestoreView> {
  const plan = s.plan!;
  const changes = plan.changes.filter((c) => !c.actions.includes('no-op')).map((c) => ({ address: c.address, actions: c.actions }));
  const expiresAt = new Date(Date.parse(plan.at) + PLAN_MAX_AGE_MS).toISOString();
  const a = newApproval({
    kind: 'restore', requestedBy: { id: me.id, email: me.email, role: me.role }, title: `Restore ${s.zone.name} from ${s.source.folder}`,
    details: [
      `Zone ${s.zone.name} · account ${s.account.credentialName}`,
      `Backup ${s.source.folder} (${s.source.kind === 'r2' ? 'R2' : 'S3'} ${s.source.bucket})`,
      `${changes.length} change${changes.length === 1 ? '' : 's'} planned${plan.hasDelete ? ', including deletions' : ''}${plan.hasReplace ? ', including replacements' : ''}`,
      `Applied with the Global API Key of ${email} (held in memory until decided)`,
    ],
    expiresAt, restore: { restoreId: s.id, zone: s.zone.name, folder: s.source.folder, keyEmail: email, planAt: plan.at, changes },
    ...(note.reason || note.ticket ? { note } : {}),
  });
  heldKeys.set(a.id, { email, apiKey, restoreId: s.id });
  // The request's own limit: the plan's age, or APPROVAL_TTL_MINUTES if that is sooner.
  s.approval = { id: a.id, requestedBy: me.email, requestedAt: a.requestedAt, expiresAt: a.expiresAt ?? expiresAt };
  s.log.push(`Apply requested by ${me.email} — waiting for a super admin to approve it (until ${s.approval.expiresAt}).`);
  track(s, 'Apply requested — waiting for a super admin', me.email);
  await audit(me, 'approval.requested', s.zone.name, { approvalId: a.id, kind: 'restore', restoreId: s.id, folder: s.source.folder, changes: changes.length, keyEmail: email, ...noteDetails(note) });
  return view(s);
}

/** Thrown when an approval can no longer go ahead (the session, key or plan is gone): the request expires. */
export class ApprovalGone extends HttpError { constructor(message: string) { super(410, message); } }

/** A super admin approved an admin's apply: it starts now, with the key held for it. */
export async function approveRestoreApply(approver: Me, a: Approval): Promise<RestoreView> {
  sweep();
  const r = a.restore!;
  const s = store.sessions.get(r.restoreId);
  const key = heldKeys.get(a.id);
  if (!s || s.approval?.id !== a.id) { heldKeys.delete(a.id); throw new ApprovalGone('The restore session has ended — the admin needs to start the restore again'); }
  if (!key) { s.approval = null; throw new ApprovalGone('The Global API Key is no longer held (the console restarted) — the admin needs to apply again'); }
  if (!s.plan || s.state !== 'planned' || Date.now() - Date.parse(s.plan.at) > PLAN_MAX_AGE_MS) {
    dropRestoreApproval(a, 'Apply request expired — the plan is older than 30 minutes', approver.email);
    throw new ApprovalGone('The plan is older than 30 minutes — the admin needs to plan again and request approval again');
  }
  assertNoJob();
  // Close to the worker's time limit: refused, the request stays pending (approvals.ts).
  assertTakingJobs();
  heldKeys.delete(a.id);
  const waiting = s.approval;
  s.approval = null;
  const requester: Me = { id: a.requestedBy.id, email: a.requestedBy.email, name: '', role: a.requestedBy.role, sessionHash: '', expiresAt: 0 };
  try {
    return await startApply(s, requester, key.email, key.apiKey, approver.email);
  } catch (err) {
    // Busy (another worker holds the account's lock): still waiting, with its key, to be approved again.
    if (err instanceof HttpError && (err.status === 409 || err.status === 503)) { heldKeys.set(a.id, key); s.approval = waiting; }
    throw err;
  }
}

/** A request rejected, withdrawn or expired: the key is dropped and the restore can be planned again. */
export function dropRestoreApproval(a: Approval, step: string, by: string) {
  heldKeys.delete(a.id);
  const s = a.restore ? store.sessions.get(a.restore.restoreId) : undefined;
  if (s && s.approval?.id === a.id) {
    s.approval = null;
    s.log.push(`${step} (${by}).`);
    track(s, step, by);
  }
}

/** Applies the reviewed plan with the Global API Key. approvedBy: the super admin who approved an admin's request. */
async function startApply(s: Session, me: Me, email: string, apiKey: string, approvedBy?: string): Promise<RestoreView> {
  const id = s.id;
  assertTakingJobs();
  await claim(id, 'applying', me.email);
  s.state = 'applying';
  s.log.push(`Applying the reviewed plan (${s.plan!.at}) — ${approvedBy ? `requested by ${me.email}, approved by ${approvedBy}` : `approved by ${me.email}`}, with the Global API Key of ${email}`);
  s.appliedBy = me.email;
  track(s, approvedBy ? `Apply approved by ${approvedBy} — started with the Global API Key of ${email}` : `Apply started with the Global API Key of ${email}`, approvedBy ?? me.email);
  await audit(me, 'restore.apply_started', s.zone.name, { restoreId: s.id, ...(approvedBy ? { approvedBy } : {}), folder: s.source.folder, auth: 'global_api_key', keyEmail: email, resources: s.plan!.changes.map((c) => `${c.address}:${c.actions.join('+')}`) });

  void (async () => {
    let ok = false;
    let applied = false;
    try {
      const auth = { 'X-Auth-Email': email, 'X-Auth-Key': apiKey };
      let verified = true;
      if (s.tfPlanned) {
        const bin = await terraformBin(s);
        const env = await terraformEnv({ email, apiKey });
        const run = await tf(s, bin, ['apply', '-input=false', '-no-color', 'tfplan'], env);
        // "Provider produced inconsistent result after apply": Cloudflare accepted the write but
        // reads an attribute back as null (a provider bug) — the change is made, so not a failure.
        const output = `${run.stdout}\n${run.stderr}`;
        const inconsistent = inconsistentAttrs(output);
        if (run.code !== 0 && !(inconsistent.size && otherErrors(output) === 0)) throw new Error('terraform apply failed');
        applied = true;
        for (const [addr, attrs] of inconsistent) s.log.push(`[WARN] ${addr}: Cloudflare accepted the change but no longer reports ${[...attrs].join(', ')} (provider bug) — not counted as a difference.`);
        // Check: a fresh plan of the same config should now show nothing to change.
        s.log.push('Checking the result with a new plan …');
        const guard = await startReadOnlyProxy();
        const check = await tf(s, bin, ['plan', '-input=false', '-no-color', '-json', '-out=checkplan'], await terraformEnv({ email, apiKey }, guard), true);
        noteBlocked(s, guard);
        await guard.close();
        const shown = check.code === 0 ? await tf(s, bin, ['show', '-json', 'checkplan'], env, true) : null;
        const checkJson = shown?.code === 0 ? JSON.parse(shown.stdout) as PlanJson : null;
        const left = checkJson ? remainingChanges(s, checkJson, inconsistent, await snippetsMatch(s, auth, checkJson)) : null;
        if (!left) { verified = false; s.log.push('[WARN] The check plan failed — see the output above.'); }
        else {
          if (left.quirks.length) s.log.push(`Disregarded (the Cloudflare provider reads these back differently from how they are written — the backup value is in place): ${left.quirks.join('; ')}`);
          if (left.real.length) { verified = false; s.log.push(`[WARN] The check plan still shows differences: ${left.real.join('; ')}`); }
        }
      }
      s.appliedAt = new Date().toISOString();
      ok = true;
      for (const c of s.apiChanges) {
        if (s.cancelRequested) throw new Cancelled();
        await setEmailRouting(s, c.enabled, auth);
        const now = await liveEmailRouting(s.zone.id, auth);
        s.log.push(now === c.enabled ? `${EMAIL_ROUTING_LABEL}: set to ${c.enabled}.` : `[WARN] ${EMAIL_ROUTING_LABEL}: still ${now} after setting it to ${c.enabled}.`);
        if (now !== c.enabled) verified = false;
      }
      s.verified = verified;
      s.log.push(s.verified ? 'Verified: the restored resources match the backup.' : '[WARN] Some restored resources do not match the backup yet — see above.');
      s.state = 'applied';
    } catch (err) {
      if (s.cancelRequested && applied) {
        // Terraform had already applied the plan; only the check afterwards was stopped.
        s.appliedAt = new Date().toISOString();
        s.verified = false;
        ok = true;
        s.state = 'applied';
        s.log.push(`[CANCELLED] The check after applying was cancelled by ${s.cancelled?.by ?? 'someone'} — the plan was applied but not verified. Compare again to check the zone.`);
      } else if (s.cancelRequested) {
        s.state = 'apply-failed';
        s.log.push(`[CANCELLED] Applying was cancelled by ${s.cancelled?.by ?? 'someone'}. Changes Terraform had already sent to Cloudflare stay; plan again to see what is left.`);
        if (s.tfPlanned) keepState(s);
      } else {
        s.state = 'apply-failed';
        s.log.push(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
        if (s.tfPlanned) keepState(s);
      }
    } finally {
      if (s.state === 'applied') s.keptState = null;
      release();
      s.expires = Date.now() + SESSION_TTL;
      await uncache(`path:/api/zone-explorer/${s.zone.id}/`);
      track(s, s.state === 'applied' ? (s.verified ? 'Applied and verified against the backup' : s.cancelRequested ? 'Applied — the check afterwards was cancelled' : 'Applied — not everything matches the backup yet') : s.cancelRequested ? 'Apply cancelled' : 'Apply failed', s.cancelRequested ? s.cancelled?.by ?? me.email : me.email);
      await audit(me, ok ? 'restore.applied' : 'restore.apply_failed', s.zone.name, {
        restoreId: s.id, folder: s.source.folder, verified: s.verified, resources: s.plan?.changes.map((c) => c.address) ?? [], ...(s.cancelRequested ? { cancelledBy: s.cancelled?.by } : {}),
      });
    }
  })();
  return view(s);
}

/**
 * Cancels the restore's running job (compare, plan or apply): stops terraform / cf-terraforming with
 * its whole process tree, and no further step starts. Compare and plan go back to before the job;
 * a cancelled apply keeps what Terraform had already sent (plan again to see what is left).
 */
export async function cancelRestore(me: Me, id: string): Promise<RestoreView> {
  const s = store.sessions.get(id);
  if (!s) throw new HttpError(404, 'Restore session not found or expired — start again');
  const job = activeRestore();
  if (store.busy !== id || !job || job.id !== id) throw new HttpError(409, 'Nothing is running for this restore');
  if (s.cancelRequested) return view(s);
  s.cancelRequested = true;
  s.cancelled = { job: job.job, by: me.email, at: new Date().toISOString() };
  s.log.push(`[CANCELLED] ${me.email} cancelled ${job.job} — stopping …`);
  track(s, `Cancel requested (${job.job})`, me.email);
  await audit(me, 'restore.cancelled', s.zone.name, { restoreId: s.id, job: job.job, folder: s.source.folder });
  const pid = s.child?.pid;
  // terraform starts the Cloudflare provider as a child process: stop the whole tree.
  if (pid && process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else s.child?.kill('SIGTERM');
  return view(s);
}
