// Backup run configuration: maps every backup.js flag / env var to a typed field.
// Shared by server and client — no Node imports.

import { BUCKET_PATTERN } from './kinds';

export const ZONE_STATUSES = ['active', 'pending', 'initializing', 'moved', 'deactivated'] as const;
export type ZoneStatus = (typeof ZONE_STATUSES)[number];

export type AccountScope = 'auto' | 'true' | 'false';

export interface BackupConfig {
  cloudflareCredentialId: string;
  /** all → every zone on the account; selected → only zoneIds (passed as -z flags). */
  zoneMode: 'all' | 'selected';
  zoneIds: string[];
  /** --with-account */
  withAccount: boolean;
  /** BACKUP_ACCOUNT */
  accountScope: AccountScope;
  /** --import (true) or --generate-only (false) */
  importMode: boolean;
  /** ZONE_STATUS_FILTER */
  statusFilter: 'all' | ZoneStatus;
  /** ZONE_STATUS_EXCLUDE */
  statusExclude: ZoneStatus[];
  /** ZONE_NAME_FILTER (shell glob) */
  nameFilter: string;
  /** AUDIT_LOG_HOURS */
  auditLogHours: number;
  /** OUTPUT_DIR; blank = console default */
  outputDir: string;
  // Uploads: on/off (R2_SKIP_UPLOAD / AWS_SKIP_UPLOAD) and which bucket. Keys, endpoint, prefix,
  // region and R2 lock rules come only from the account set (cloudflareCredentialId), and the
  // bucket must be one approved there (blank = its default) — a backup can never go to storage
  // that belongs to another account set.
  r2: { enabled: boolean; bucket: string };
  aws: { enabled: boolean; bucket: string };
}

export const DEFAULT_CONFIG: BackupConfig = {
  cloudflareCredentialId: '',
  zoneMode: 'all',
  zoneIds: [],
  withAccount: false,
  accountScope: 'auto',
  importMode: false,
  statusFilter: 'all',
  statusExclude: ['moved'],
  nameFilter: '*',
  auditLogHours: 72,
  outputDir: '',
  r2: { enabled: false, bucket: '' },
  aws: { enabled: false, bucket: '' },
};

const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);

/**
 * Builds a config from untrusted input (request body, older presets) using only known
 * fields — anything else, such as the old per-run bucket/region/lock-rule overrides, is dropped.
 */
export function normalizeConfig(input: Partial<BackupConfig> | undefined): BackupConfig {
  const c = (input ?? {}) as Partial<BackupConfig>;
  const d = DEFAULT_CONFIG;
  return {
    cloudflareCredentialId: str(c.cloudflareCredentialId, d.cloudflareCredentialId),
    zoneMode: c.zoneMode === 'selected' ? 'selected' : 'all',
    zoneIds: Array.isArray(c.zoneIds) ? c.zoneIds.filter((z): z is string => typeof z === 'string') : [],
    withAccount: c.withAccount === true,
    accountScope: (['auto', 'true', 'false'] as const).find((s) => s === c.accountScope) ?? d.accountScope,
    importMode: c.importMode === true,
    statusFilter: (c.statusFilter as BackupConfig['statusFilter']) ?? d.statusFilter,
    statusExclude: Array.isArray(c.statusExclude) ? c.statusExclude : d.statusExclude,
    nameFilter: str(c.nameFilter, d.nameFilter),
    auditLogHours: typeof c.auditLogHours === 'number' ? c.auditLogHours : d.auditLogHours,
    outputDir: str(c.outputDir, d.outputDir),
    // Older presets also named a separate storage credential; storage now comes only from the account set.
    r2: { enabled: c.r2?.enabled === true, bucket: str(c.r2?.bucket, '').trim() },
    aws: { enabled: c.aws?.enabled === true, bucket: str(c.aws?.bucket, '').trim() },
  };
}

const ZONE_ID_RE = /^[0-9a-f]{32}$/;

/** Returns human-readable problems; empty when the config can be run. */
export function validateConfig(c: BackupConfig): string[] {
  const errs: string[] = [];
  if (!c.cloudflareCredentialId) errs.push('Choose an account set from the vault.');
  if (c.zoneMode === 'selected') {
    if (c.zoneIds.length === 0) errs.push('Select at least one zone, or back up all zones.');
    const bad = c.zoneIds.filter((z) => !ZONE_ID_RE.test(z));
    if (bad.length) errs.push(`Not a zone ID: ${bad.join(', ')}`);
  }
  if (!['auto', 'true', 'false'].includes(c.accountScope)) errs.push('Invalid account scope.');
  if (c.statusFilter !== 'all' && !ZONE_STATUSES.includes(c.statusFilter)) errs.push('Invalid zone status filter.');
  if (c.statusExclude.some((s) => !ZONE_STATUSES.includes(s))) errs.push('Invalid excluded zone status.');
  if (!Number.isInteger(c.auditLogHours) || c.auditLogHours < 1 || c.auditLogHours > 24 * 90) {
    errs.push('Audit log window must be 1–2160 hours.');
  }
  if (/[\r\n]/.test(c.nameFilter) || /[\r\n]/.test(c.outputDir)) errs.push('Filters and paths must be one line.');
  if (typeof c.nameFilter !== 'string' || c.nameFilter.length > 200) errs.push('Zone name filter is too long.');
  const bucketRe = new RegExp(BUCKET_PATTERN);
  if (c.r2.enabled && c.r2.bucket && !bucketRe.test(c.r2.bucket)) errs.push('The R2 bucket name is not valid.');
  if (c.aws.enabled && c.aws.bucket && !bucketRe.test(c.aws.bucket)) errs.push('The S3 bucket name is not valid.');
  return errs;
}

/** Whether backup.js will include account-level resources (mirrors its parseArgs). */
export function includesAccount(c: BackupConfig): boolean {
  const explicitZones = c.zoneMode === 'selected' && c.zoneIds.length > 0;
  if (c.accountScope === 'true') return true;
  if (c.accountScope === 'false') return c.withAccount;
  return !explicitZones || c.withAccount;
}

/** Command-line arguments for backup.js. */
export function buildArgs(c: BackupConfig): string[] {
  const args: string[] = [c.importMode ? '--import' : '--generate-only'];
  if (c.zoneMode === 'selected') for (const z of c.zoneIds) args.push('-z', z);
  if (c.withAccount) args.push('--with-account');
  return args;
}
