import 'server-only';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { DATA_DIR, DEFAULT_OUTPUT_DIR, RUNNER_DIR, RUNNER_SCRIPT, newId } from './store';
import { buildArgs, validateConfig, type BackupConfig } from './config';
import { AWS_REGION_PATTERN, BUCKET_PATTERN, PREFIX_PATTERN, R2_ENDPOINT_PATTERN, approvedBuckets } from './kinds';
import { getSettings } from './settings';
import { credentialForRun, markUsed, storageOf, type Credential } from './vault';
import { summarizeLines, type RunMeta, type RunStatus } from './run-types';
import { HttpError } from './http';
import { db, must, publicSignupEnabled } from './supabase';
import { audit } from './audit';
import type { Me } from './auth';
import { TOOLS_BIN, ensureTools, resolveTools } from './tools';
import { systemPath, systemPathSources } from './syspath';
import { activeRestore } from './job-lock';
import { listZones, tokenAccounts } from './providers';

// Every variable backup.js reads from its environment. Inherited values are
// dropped so only what the console sets reaches the script.
const SCRIPT_ENV_KEYS = [
  'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'ZONE_STATUS_FILTER', 'ZONE_STATUS_EXCLUDE', 'ZONE_NAME_FILTER',
  'ZONE_IDS', 'BACKUP_ACCOUNT', 'BACKUP_MODE', 'OUTPUT_DIR', 'AUDIT_LOG_HOURS',
  'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_ENDPOINT', 'R2_PREFIX', 'R2_SKIP_UPLOAD',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_S3_BUCKET', 'AWS_REGION', 'AWS_SKIP_UPLOAD', 'AWS_SESSION_TOKEN',
];
const SECRET_ENV_KEYS = new Set(['CF_API_TOKEN', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
// The console's own secrets (Supabase keys, vault server key) must never reach backup.js or terraform.
const CONSOLE_ENV_RE = /^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|VAULT_|CONSOLE_|REDIS_)/i;
const MAX_MEMORY_LINES = 20_000;
const LOG_BATCH = 250;
const LOG_FLUSH_MS = 1000;

type Listener = (event: { type: 'line'; line: string } | { type: 'status'; meta: RunMeta }) => void;

interface LiveRun {
  meta: RunMeta;
  lines: string[];
  listeners: Set<Listener>;
  /** null while tools are still being provisioned */
  child: ChildProcess | null;
  secrets: string[];
  cancelled: boolean;
}

const g = globalThis as unknown as { __cfRuns?: Map<string, LiveRun> };
const live: Map<string, LiveRun> = (g.__cfRuns ??= new Map());

const validId = (id: string) => /^[A-Za-z0-9_-]{6,40}$/.test(id);

// ── Supabase mapping ────────────────────────────────────────────────────────

interface RunRow {
  id: string; status: RunStatus; started_at: string; ended_at: string | null; exit_code: number | null; preset_name: string | null;
  config: BackupConfig; output_dir: string | null; credential_names: RunMeta['credentialNames']; command: string;
  summary: RunMeta['summary']; started_by_email: string | null;
}
const RUN_COLS = 'id, status, started_at, ended_at, exit_code, preset_name, config, output_dir, credential_names, command, summary, started_by_email';

const fromRow = (r: RunRow): RunMeta => ({
  id: r.id, status: r.status, startedAt: r.started_at, endedAt: r.ended_at ?? undefined, exitCode: r.exit_code,
  presetName: r.preset_name ?? undefined, config: r.config, outputDir: r.output_dir ?? undefined,
  credentialNames: r.credential_names ?? {}, command: r.command, summary: Object.assign({ warnings: 0, errors: 0 }, r.summary),
  startedBy: r.started_by_email ?? undefined,
});

async function saveStatus(meta: RunMeta) {
  const { error } = await db().from('runs').update({
    status: meta.status, ended_at: meta.endedAt ?? null, exit_code: meta.exitCode ?? null, summary: meta.summary,
  }).eq('id', meta.id);
  if (error) console.error(`saving run ${meta.id} failed:`, error.message);
}

function findPathKey(env: NodeJS.ProcessEnv) {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}

/** PATH for runs: console-managed tools first, then the system PATH as the OS currently defines it. */
export function augmentedEnvPath(env: NodeJS.ProcessEnv = { ...process.env }) {
  const key = findPathKey(env);
  for (const k of Object.keys(env)) if (k !== key && k.toUpperCase() === 'PATH') delete env[k];
  env[key] = [TOOLS_BIN, ...systemPath()].join(path.delimiter);
  return env;
}

function assertFormat(value: string, pattern: string, label: string) {
  if (!new RegExp(pattern).test(value ?? '')) {
    throw new HttpError(400, `${label} has an invalid format — a super admin must fix the credential before it can be used`);
  }
}

function redactor(secrets: string[]) {
  const list = secrets.filter((s) => s && s.length >= 4).sort((a, b) => b.length - a.length);
  return (s: string) => list.reduce((acc, sec) => acc.split(sec).join('••••••••'), s);
}

function shellQuote(v: string) { return /^[A-Za-z0-9_./:@,*=-]*$/.test(v) && v ? v : `'${v.replace(/'/g, `'\\''`)}'`; }

export function activeRunId(): string | null {
  for (const [id, r] of live) if (r.meta.status === 'running') return id;
  return null;
}

/** The Cloudflare credential the running backup uses (monitoring leaves its token alone meanwhile). */
export function activeRunCredentialId(): string | null {
  for (const r of live.values()) if (r.meta.status === 'running') return r.meta.config.cloudflareCredentialId ?? null;
  return null;
}

/** A restore job (compare, plan, apply) blocks backups: one job at a time. */
function assertNoRestore() {
  const r = activeRestore();
  if (r) throw new HttpError(409, `A restore of ${r.zone} is running (${r.job}, by ${r.by}) — wait for it to finish`);
}

/**
 * Every check a backup start makes about its configuration, without starting anything: run when an
 * operator asks for approval, so an approver only ever sees requests that can run.
 */
/** A chosen account must be one the set covers: its own account ID, or one its token can access. */
async function assertAccountChoice(cf: Credential, config: BackupConfig) {
  if (!config.accountId) return;
  const fixed = cf.fields.accountId?.trim();
  if (fixed) {
    if (fixed !== config.accountId) throw new HttpError(400, `"${cf.name}" is for account ${fixed}, not ${config.accountId}`);
    return;
  }
  const reachable = await tokenAccounts(cf).catch((err) => { throw new HttpError(502, err instanceof Error ? err.message : String(err)); });
  if (!reachable.some((a) => a.id === config.accountId)) throw new HttpError(400, `The token of "${cf.name}" cannot access account ${config.accountId}`);
}

export async function checkRunConfig(config: BackupConfig): Promise<{ cloudflare: string; r2Bucket: string; awsBucket: string; outputDir: string }> {
  const problems = validateConfig(config);
  if (problems.length) throw new HttpError(400, problems.join(' '));
  const cf = await credentialForRun(config.cloudflareCredentialId, 'cloudflare');
  await assertAccountChoice(cf, config);
  const r2 = config.r2.enabled ? storageOf(cf, 'r2') : null;
  const aws = config.aws.enabled ? storageOf(cf, 'aws') : null;
  const settings = await getSettings();
  const root = path.resolve(settings.outputDir || DEFAULT_OUTPUT_DIR);
  const outputDir = path.resolve(root, config.outputDir || '.');
  const rel = path.relative(root, outputDir);
  if (/^(\\\\|\/\/)/.test(config.outputDir) || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new HttpError(400, `The output folder must be inside ${root} (Settings › output folder)`);
  }
  const pick = (c: Credential, wanted: string, label: string) => {
    const bucket = wanted || c.fields.bucket;
    if (!approvedBuckets(c.fields).includes(bucket)) {
      throw new HttpError(400, `${label} bucket "${bucket}" is not approved for "${c.name}" — a super admin can add it to the account set's approved buckets`);
    }
    return bucket;
  };
  const r2Bucket = r2 ? pick(r2, config.r2.bucket, 'R2') : '';
  const awsBucket = aws ? pick(aws, config.aws.bucket, 'S3') : '';
  if (r2) {
    assertFormat(r2Bucket, BUCKET_PATTERN, `R2 bucket of "${r2.name}"`);
    assertFormat(r2.fields.prefix ?? '', PREFIX_PATTERN, `R2 prefix of "${r2.name}"`);
    assertFormat(r2.fields.endpoint, R2_ENDPOINT_PATTERN, `R2 endpoint of "${r2.name}"`);
  }
  if (aws) assertFormat(awsBucket, BUCKET_PATTERN, `S3 bucket of "${aws.name}"`);
  return { cloudflare: cf.name, r2Bucket, awsBucket, outputDir };
}

/**
 * The accounts a run backs up, each with the chosen zones in it: the credential's account ID, or
 * (left empty) every account its token can access.
 */
async function accountsToBackUp(cf: Credential, config: BackupConfig, log: (m: string, level?: 'info' | 'ok' | 'warn') => void) {
  const fixed = cf.fields.accountId?.trim();
  if (fixed) return [{ id: fixed, name: '', zoneIds: config.zoneIds }];
  const reachable = await tokenAccounts(cf);
  const all = config.accountId ? reachable.filter((a) => a.id === config.accountId) : reachable;
  if (!all.length) throw new Error(`The token of "${cf.name}" cannot access account ${config.accountId}`);
  log(config.accountId
    ? `Backing up account ${all[0].name || all[0].id} (one of the ${reachable.length} accounts the token of "${cf.name}" can access)`
    : `No account ID on "${cf.name}": backing up the ${all.length} account${all.length === 1 ? '' : 's'} the token can access — ${all.map((a) => a.name || a.id).join(', ')}`);
  if (config.zoneMode !== 'selected') return all.map((a) => ({ ...a, zoneIds: [] }));
  const zones = await listZones(cf);
  const accountOf = new Map(zones.map((z) => [z.id, z.accountId]));
  const unknown = config.zoneIds.filter((z) => !accountOf.has(z));
  if (unknown.length) log(`${unknown.length} chosen zone(s) are not visible to the token and are skipped: ${unknown.join(', ')}`, 'warn');
  return all.map((a) => ({ ...a, zoneIds: config.zoneIds.filter((z) => accountOf.get(z) === a.id) })).filter((a) => a.zoneIds.length);
}

export async function startRun(me: Me, config: BackupConfig, presetName?: string, approval?: { id: string; by: string }): Promise<RunMeta> {
  const running = activeRunId();
  if (running) throw new HttpError(409, 'A backup is already running — wait for it or cancel it first');
  assertNoRestore();
  const problems = validateConfig(config);
  if (problems.length) throw new HttpError(400, problems.join(' '));
  if (!fs.existsSync(RUNNER_SCRIPT)) throw new HttpError(500, 'The backup script is missing — see Settings › Environment');
  // backup.js lets a .env next to it override the environment — that would silently bypass the vault.
  if (fs.existsSync(path.join(RUNNER_DIR, '.env'))) {
    throw new HttpError(500, 'Remove the .env file in the runner folder — it would override the vault credentials');
  }

  const cf = await credentialForRun(config.cloudflareCredentialId, 'cloudflare');
  await assertAccountChoice(cf, config);
  // Storage comes only from the same account set: one account's backup cannot reach another's bucket.
  const r2 = config.r2.enabled ? storageOf(cf, 'r2') : null;
  const aws = config.aws.enabled ? storageOf(cf, 'aws') : null;
  const settings = await getSettings();
  // Re-check after the awaits so two quick clicks cannot start two runs.
  if (activeRunId()) throw new HttpError(409, 'A backup is already running — wait for it or cancel it first');
  assertNoRestore();
  // A run may pick a folder, but only inside the output folder an admin set in Settings: an
  // operator must not write backups (the whole configuration) anywhere else — another disk
  // location, or a network share, which on Windows would also send the account's NTLM hash.
  const root = path.resolve(settings.outputDir || DEFAULT_OUTPUT_DIR);
  const outputDir = path.resolve(root, config.outputDir || '.');
  const rel = path.relative(root, outputDir);
  if (/^(\\\\|\/\/)/.test(config.outputDir) || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new HttpError(400, `The output folder must be inside ${root} (Settings › output folder)`);
  }

  const vars: Record<string, string> = {
    CF_API_TOKEN: cf.fields.apiToken,
    CF_ACCOUNT_ID: cf.fields.accountId,
    ZONE_IDS: '',
    BACKUP_ACCOUNT: config.accountScope,
    BACKUP_MODE: config.importMode ? 'import' : 'generate',
    ZONE_STATUS_FILTER: config.statusFilter,
    ZONE_STATUS_EXCLUDE: config.statusExclude.join(' '),
    ZONE_NAME_FILTER: config.nameFilter.trim() || '*',
    OUTPUT_DIR: outputDir,
    AUDIT_LOG_HOURS: String(config.auditLogHours),
    R2_SKIP_UPLOAD: r2 ? 'false' : 'true',
    AWS_SKIP_UPLOAD: aws ? 'false' : 'true',
  };
  // Upload targets come only from the (super-admin-controlled) credential: the run may pick
  // one of its approved buckets, nothing else. Formats are re-validated because credentials
  // saved by older versions were not.
  const pick = (c: Credential, wanted: string, label: string) => {
    const bucket = wanted || c.fields.bucket;
    if (!approvedBuckets(c.fields).includes(bucket)) {
      throw new HttpError(400, `${label} bucket "${bucket}" is not approved for "${c.name}" — a super admin can add it to the account set's approved buckets`);
    }
    return bucket;
  };
  const r2Bucket = r2 ? pick(r2, config.r2.bucket, 'R2') : '';
  const awsBucket = aws ? pick(aws, config.aws.bucket, 'S3') : '';
  const lockFile = path.join(RUNNER_DIR, 'r2_lock_rules.json');
  fs.rmSync(lockFile, { force: true });
  if (r2) {
    assertFormat(r2Bucket, BUCKET_PATTERN, `R2 bucket of "${r2.name}"`);
    assertFormat(r2.fields.prefix ?? '', PREFIX_PATTERN, `R2 prefix of "${r2.name}"`);
    assertFormat(r2.fields.endpoint, R2_ENDPOINT_PATTERN, `R2 endpoint of "${r2.name}"`);
    Object.assign(vars, {
      R2_ACCESS_KEY_ID: r2.fields.accessKeyId,
      R2_SECRET_ACCESS_KEY: r2.fields.secretAccessKey,
      R2_ENDPOINT: r2.fields.endpoint,
      R2_BUCKET_NAME: r2Bucket,
      R2_PREFIX: r2.fields.prefix ?? '',
    });
    // backup.js reads lock rules from a fixed path next to itself. No file = it restores
    // whatever rules the bucket had before the upload.
    if (r2.fields.lockRules?.trim()) fs.writeFileSync(lockFile, r2.fields.lockRules, { mode: 0o600 });
  }
  if (aws) {
    assertFormat(awsBucket, BUCKET_PATTERN, `S3 bucket of "${aws.name}"`);
    // The stored region belongs to the default bucket; backup.js detects any other bucket's region.
    const region = awsBucket === aws.fields.bucket ? aws.fields.region ?? '' : '';
    if (region) assertFormat(region, AWS_REGION_PATTERN, `AWS region of "${aws.name}"`);
    Object.assign(vars, {
      AWS_ACCESS_KEY_ID: aws.fields.accessKeyId,
      AWS_SECRET_ACCESS_KEY: aws.fields.secretAccessKey,
      AWS_S3_BUCKET: awsBucket,
      AWS_REGION: region,
    });
  }

  const args = buildArgs(config);
  // No account ID: backup.js runs once per account the token can access.
  const shown = { ...vars, CF_ACCOUNT_ID: vars.CF_ACCOUNT_ID || '<each account the token can access>' };
  const command = [
    ...Object.entries(shown).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${SECRET_ENV_KEYS.has(k) ? '••••••••' : shellQuote(v)}`),
    'node backup.js',
    ...args,
  ].join(' \\\n  ');

  const id = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${newId(4)}`;
  const now = new Date().toISOString();
  // The stored config names the buckets actually used, so the run record and "run again" show them.
  config = { ...config, r2: { ...config.r2, bucket: r2Bucket }, aws: { ...config.aws, bucket: awsBucket } };
  const meta: RunMeta = {
    id, status: 'running', startedAt: now, presetName, config, command, outputDir,
    credentialNames: { cloudflare: cf.name, r2: r2 ? cf.name : undefined, aws: aws ? cf.name : undefined },
    summary: { warnings: 0, errors: 0 }, startedBy: me.email,
  };

  const run: LiveRun = {
    meta, lines: [], listeners: new Set(), child: null,
    secrets: [cf.fields.apiToken, r2?.fields.accessKeyId, r2?.fields.secretAccessKey, aws?.fields.accessKeyId, aws?.fields.secretAccessKey]
      .filter((s): s is string => !!s),
    cancelled: false,
  };
  // Claim the slot before awaiting the insert.
  live.set(id, run);
  const { error: insErr } = await db().from('runs').insert({
    id, status: 'running', started_at: now, preset_name: presetName ?? null, config, output_dir: outputDir,
    credential_names: meta.credentialNames, command, summary: meta.summary, started_by: me.id, started_by_email: me.email,
  });
  if (insErr) { live.delete(id); throw new Error(`Could not record the run: ${insErr.message}`); }
  await audit(me, 'run.started', id, {
    ...(approval ? { approvalId: approval.id, approvedBy: approval.by } : {}),
    preset: presetName ?? null, cloudflare: cf.name, r2: r2?.name ?? null, aws: aws?.name ?? null, r2Bucket: r2Bucket || null, awsBucket: awsBucket || null,
  });
  const redact = redactor(run.secrets);

  // Log lines are batched into run_logs; writes are chained so they land in order.
  let seq = 0;
  let pending: { run_id: string; seq: number; line: string }[] = [];
  let writing: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  const flushLog = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pending.length) return writing;
    const batch = pending;
    pending = [];
    writing = writing.then(async () => {
      const { error } = await db().from('run_logs').insert(batch);
      if (error) console.error(`writing log for run ${id} failed:`, error.message);
    });
    return writing;
  };

  const push = (line: string) => {
    const clean = redact(line);
    run.lines.push(clean);
    if (run.lines.length > MAX_MEMORY_LINES) run.lines.splice(0, run.lines.length - MAX_MEMORY_LINES);
    pending.push({ run_id: id, seq: seq++, line: clean });
    if (pending.length >= LOG_BATCH) void flushLog();
    else timer ??= setTimeout(() => void flushLog(), LOG_FLUSH_MS);
    summarizeLines([clean], meta.summary);
    for (const l of run.listeners) l({ type: 'line', line: clean });
  };
  const lineSplitter = () => {
    let buf = '';
    return {
      data: (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? '';
        parts.forEach(push);
      },
      flush: () => { if (buf) push(buf); buf = ''; },
    };
  };
  const outS = lineSplitter();
  const errS = lineSplitter();

  const finish = (code: number | null, error?: string) => {
    if (meta.status !== 'running') return;
    outS.flush();
    errS.flush();
    if (error) push(`\x1b[0;31m[ERROR]\x1b[0m ${error}`);
    meta.exitCode = code;
    meta.endedAt = new Date().toISOString();
    meta.status = run.cancelled ? 'cancelled' : code === 0 ? 'succeeded' : 'failed';
    void flushLog().then(() => saveStatus(meta));
    for (const l of run.listeners) l({ type: 'status', meta });
    run.listeners.clear();
    // Keep the finished run in memory briefly so late subscribers still get it from RAM.
    setTimeout(() => live.delete(id), 60_000).unref?.();
  };
  const LEVEL = { info: '\x1b[0;34m[INFO]\x1b[0m ', ok: '\x1b[0;32m[OK]\x1b[0m   ', warn: '\x1b[1;33m[WARN]\x1b[0m ' };
  const log = (m: string, level: keyof typeof LEVEL = 'info') => push(`${LEVEL[level]} ${m}`);

  // Provision tools online, then hand over to backup.js.
  (async () => {
    push('\x1b[0;36m\x1b[1m━━━  Preparing tools  ━━━\x1b[0m');
    try {
      await ensureTools(log, () => run.cancelled);
    } catch (err) {
      finish(null, err instanceof Error ? err.message : String(err));
      return;
    }
    if (run.cancelled) { finish(null); return; }

    // The accounts to back up: the credential's account, or (no account ID) every account the
    // token can access. With chosen zones, only the accounts those zones are in.
    let accounts: { id: string; name: string; zoneIds: string[] }[];
    try {
      accounts = await accountsToBackUp(cf, config, log);
    } catch (err) {
      finish(null, err instanceof Error ? err.message : String(err));
      return;
    }
    if (!accounts.length) { finish(null, 'None of the chosen zones is in an account this token can access'); return; }

    const env = augmentedEnvPath({ ...process.env });
    for (const k of Object.keys(env)) if (SCRIPT_ENV_KEYS.includes(k.toUpperCase()) || CONSOLE_ENV_RE.test(k)) delete env[k];
    // GitHub Actions (the worker) sets CI=true, and cf-terraforming then skips creating its API
    // client (meant for its own test recordings) and crashes on the first call.
    delete env.CI;
    Object.assign(env, vars);
    env.HOME ||= os.homedir();
    env.TF_PLUGIN_CACHE_DIR = settings.pluginCacheDir || env.TF_PLUGIN_CACHE_DIR || path.join(DATA_DIR, 'plugin-cache');
    env.TF_IN_AUTOMATION = '1';

    // backup.js backs up one account: it runs once per account, one after the other, in this run.
    const failed: string[] = [];
    for (const [i, acct] of accounts.entries()) {
      if (run.cancelled) break;
      if (accounts.length > 1) push(`\x1b[0;36m\x1b[1m━━━  Account ${i + 1} of ${accounts.length}: ${acct.name || acct.id} (${acct.id})  ━━━\x1b[0m`);
      const accountArgs = buildArgs({ ...config, zoneIds: acct.zoneIds });
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [RUNNER_SCRIPT, ...accountArgs], { cwd: RUNNER_DIR, env: { ...env, CF_ACCOUNT_ID: acct.id }, windowsHide: true });
        run.child = child;
        child.stdout?.on('data', outS.data);
        child.stderr?.on('data', errS.data);
        child.on('error', (e) => { push(`\x1b[0;31m[ERROR]\x1b[0m Could not start backup.js: ${e.message}`); resolve(null); });
        child.on('close', (c) => { outS.flush(); errS.flush(); resolve(c); });
      });
      if (code !== 0 && !run.cancelled) failed.push(acct.name || acct.id);
    }
    if (accounts.length > 1 && !run.cancelled) {
      log(failed.length ? `${accounts.length - failed.length} of ${accounts.length} accounts backed up; failed: ${failed.join(', ')}` : `All ${accounts.length} accounts backed up`, failed.length ? 'warn' : 'ok');
    }
    finish(failed.length ? 1 : 0);
  })();

  void markUsed([cf, r2, aws].flatMap((c) => (c ? [c.id] : []))).catch(() => {});
  return meta;
}

export async function cancelRun(me: Me, id: string) {
  const run = live.get(id);
  if (!run || run.meta.status !== 'running') throw new HttpError(409, 'This run is not running');
  run.cancelled = true;
  await audit(me, 'run.cancelled', id);
  // Still provisioning tools: the launcher sees the flag and never spawns the script.
  if (!run.child) return;
  const pid = run.child.pid;
  // terraform / cf-terraforming are grandchildren: kill the whole tree.
  if (process.platform === 'win32' && pid) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else run.child.kill('SIGTERM');
}

/** A run marked running in the database but unknown to this process was cut off by a restart. */
function settleOrphan(meta: RunMeta): RunMeta {
  if (meta.status === 'running' && !live.has(meta.id)) {
    meta.status = 'interrupted';
    meta.endedAt ??= new Date().toISOString();
    void saveStatus(meta);
  }
  return meta;
}

export async function getRun(id: string): Promise<RunMeta | null> {
  if (!validId(id)) return null;
  const l = live.get(id);
  if (l) return l.meta;
  const r = must(await db().from('runs').select(RUN_COLS).eq('id', id).maybeSingle(), 'Reading run') as RunRow | null;
  return r ? settleOrphan(fromRow(r)) : null;
}

/**
 * A run as stored in Supabase, without settling it: on the web role (Vercel) runs live on the
 * worker, so "not running in this process" says nothing about whether it is still running.
 */
export async function storedRun(id: string): Promise<RunMeta | null> {
  if (!validId(id)) return null;
  const r = must(await db().from('runs').select(RUN_COLS).eq('id', id).maybeSingle(), 'Reading run') as RunRow | null;
  return r ? fromRow(r) : null;
}

/** Log lines from `seq` on (as stored in Supabase), with the seq to read from next. */
export async function storedRunLog(id: string, seq: number): Promise<{ lines: string[]; next: number }> {
  const rows = must(await db().from('run_logs').select('seq, line').eq('run_id', id).gte('seq', seq).order('seq').limit(1000), 'Reading run log') as { seq: number; line: string }[];
  return { lines: rows.map((r) => r.line), next: rows.length ? rows[rows.length - 1].seq + 1 : seq };
}

export async function listRuns(limit = 200): Promise<RunMeta[]> {
  const rows = must(await db().from('runs').select(RUN_COLS).order('started_at', { ascending: false }).limit(limit), 'Listing runs') as RunRow[];
  return rows.map((r) => live.get(r.id)?.meta ?? settleOrphan(fromRow(r)));
}

export async function deleteRun(me: Me, id: string) {
  if (!validId(id)) throw new HttpError(404, 'Run not found');
  if (live.get(id)?.meta.status === 'running') throw new HttpError(409, 'Cancel the run before deleting it');
  live.delete(id);
  const deleted = must(await db().from('runs').delete().eq('id', id).select('id'), 'Deleting run') as { id: string }[];
  if (deleted.length) await audit(me, 'run.deleted', id);
}

export async function readRunLog(id: string): Promise<string[]> {
  const l = live.get(id);
  if (l) return [...l.lines];
  const out: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const rows = must(await db().from('run_logs').select('line').eq('run_id', id).order('seq').range(from, from + PAGE - 1), 'Reading run log') as { line: string }[];
    for (const r of rows) out.push(r.line);
    if (rows.length < PAGE) break;
  }
  return out;
}

export function subscribe(id: string, fn: Listener): (() => void) | null {
  const l = live.get(id);
  if (!l || l.meta.status !== 'running') return null;
  l.listeners.add(fn);
  return () => l.listeners.delete(fn);
}

/** Reads _backup_summary.txt from the run's backup folder, if the run got that far. */
export function readIntegritySummary(meta: RunMeta): string | null {
  const root = meta.summary.backupRoot;
  if (!root) return null;
  try {
    return fs.readFileSync(path.join(root, '_backup_summary.txt'), 'utf8');
  } catch {
    return null;
  }
}

function signupCheck(enabled: boolean | null) {
  if (enabled === null) return { ok: false, detail: 'could not read Supabase Auth settings — check that sign-ups are disabled' };
  return enabled
    ? { ok: false, detail: 'Supabase Auth still allows public sign-up — disable it under Authentication › Sign In / Providers' }
    : { ok: true, detail: 'public sign-up is disabled' };
}

/** Prerequisite probe for the settings page. */
export async function systemCheck() {
  const version = (bin: string, name: string) => {
    const r = spawnSync(bin, name === 'terraform' ? ['version', '-json'] : ['version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    if (r.status !== 0) return null;
    if (name === 'terraform') { try { return `v${JSON.parse(r.stdout).terraform_version}`; } catch { return null; } }
    return /v\d+\.\d+\.\d+/.exec(r.stdout)?.[0] ?? null;
  };
  const resolved = resolveTools().map((t) => {
    const v = t.effective ? version(t.effective, t.name) : null;
    const check = v
      ? { ok: true, detail: `${v} · ${t.managed ? 'console-managed' : 'system PATH'} · ${t.effective}` }
      : { ok: false, detail: 'Not provisioned — downloaded automatically when the next backup starts' };
    return { ...t, check };
  });
  const tool = (n: string) => resolved.find((t) => t.name === n)!.check;
  const settings = await getSettings();
  const outputDir = path.resolve(settings.outputDir || DEFAULT_OUTPUT_DIR);
  return {
    node: { ok: Number(process.versions.node.split('.')[0]) >= 18, detail: `v${process.versions.node}` },
    terraform: tool('terraform'),
    cfTerraforming: tool('cf-terraforming'),
    path: { managed: TOOLS_BIN, sources: systemPathSources() },
    script: { ok: fs.existsSync(RUNNER_SCRIPT), detail: RUNNER_SCRIPT },
    envOverride: { ok: !fs.existsSync(path.join(RUNNER_DIR, '.env')), detail: path.join(RUNNER_DIR, '.env') },
    signupDisabled: signupCheck(await publicSignupEnabled()),
    vaultKeyFile: process.env.VAULT_SERVER_KEY_FILE?.trim()
      ? { ok: false, detail: 'VAULT_SERVER_KEY_FILE is no longer used: the key is kept in Supabase. Remove the line from .env.local' }
      : process.env.VAULT_SERVER_KEY?.trim()
        ? { ok: true, detail: 'VAULT_SERVER_KEY in the environment (overrides the key in Supabase)' }
        : { ok: true, detail: 'kept in Supabase (vault_keys, service role only)' },
    legacyVault: fs.existsSync(path.join(DATA_DIR, 'vault.json'))
      ? { ok: false, detail: `${path.join(DATA_DIR, 'vault.json')} (pre-Supabase vault) is still on disk — delete it once its credentials are re-added` }
      : { ok: true, detail: 'no pre-Supabase vault file left' },
    outputDir,
    dataDir: DATA_DIR,
    platform: `${process.platform} ${os.release()}`,
  };
}
