// Credential kinds stored in the vault. Shared by server and client — no Node imports.

export type CredentialKind = 'cloudflare' | 'r2' | 'aws';
/** Where backups are uploaded. Configured inside an account set, never on their own. */
export type StorageKind = 'r2' | 'aws';
export const STORAGE_LABEL: Record<StorageKind, string> = { r2: 'Cloudflare R2', aws: 'AWS S3' };

export interface FieldDef {
  key: string;
  label: string;
  /** Encrypted at rest like everything else, but also never sent to the browser unmasked. */
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
  pattern?: string;
  patternHint?: string;
  /** Multi-line value (textarea); must parse as JSON when `json` is set. */
  multiline?: boolean;
  json?: boolean;
  /** One value per line; `pattern` applies to each line. */
  list?: boolean;
  /** Optional section of an account set: all of its required fields, or none of them. */
  group?: StorageKind;
}

// Validation shared by the vault editor, the server and backup.js — these values end
// up in URLs (bucket names, regions), so they are restricted to their real formats.
export const BUCKET_PATTERN = '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$';
export const PREFIX_PATTERN = '^(?!.*\\.\\.)[A-Za-z0-9._/-]{0,200}$';
export const AWS_REGION_PATTERN = '^[a-z]{2}(-[a-z]+)+-\\d{1,2}$';
export const R2_ENDPOINT_PATTERN = '^https://[0-9a-f]{32}\\.(?:[a-z]+\\.)?r2\\.cloudflarestorage\\.com/?$';
export const DEFAULT_LOCK_RULES = '{\n  "rules": []\n}';

/**
 * Buckets a run may choose besides the default. Only a super admin edits credentials,
 * so this list is what keeps a run from sending backups to a bucket nobody approved.
 */
const EXTRA_BUCKETS: FieldDef = {
  key: 'extraBuckets', label: 'Other approved buckets', secret: false, required: false, multiline: true, list: true,
  placeholder: 'one bucket per line', pattern: BUCKET_PATTERN, patternHint: 'each line must be a bucket name (3–63 lowercase letters, digits, dots or hyphens)',
  help: 'Whoever starts a backup can pick the default bucket or any bucket listed here. Use “Find buckets” to see what these keys can reach.',
};
export const MAX_EXTRA_BUCKETS = 50;

/** The buckets a run may upload to with this credential: the default first. */
export function approvedBuckets(fields: Record<string, string | undefined>): string[] {
  const re = new RegExp(BUCKET_PATTERN);
  const all = [fields.bucket ?? '', ...(fields.extraBuckets ?? '').split(/\r?\n/)].map((b) => b.trim()).filter((b) => re.test(b));
  return [...new Set(all)];
}

export interface KindDef {
  label: string;
  short: string;
  description: string;
  fields: FieldDef[];
  /** Kept to read credentials saved before account sets; cannot be created or used for runs. */
  legacy?: boolean;
}

const R2_FIELDS: FieldDef[] = [
  { key: 'accessKeyId', label: 'Access key ID', secret: true, required: true, placeholder: 'R2 access key ID' },
  { key: 'secretAccessKey', label: 'Secret access key', secret: true, required: true, placeholder: 'R2 secret access key' },
  {
    key: 'endpoint', label: 'Endpoint', secret: false, required: true,
    placeholder: 'https://<account_id>.r2.cloudflarestorage.com', pattern: R2_ENDPOINT_PATTERN,
    patternHint: 'must be https://<32-hex account id>.r2.cloudflarestorage.com (optionally with a jurisdiction such as .eu)',
  },
  {
    key: 'bucket', label: 'Default bucket', secret: false, required: true, placeholder: 'terraform-backup',
    pattern: BUCKET_PATTERN, patternHint: '3–63 lowercase letters, digits, dots or hyphens',
  },
  EXTRA_BUCKETS,
  {
    key: 'prefix', label: 'Prefix', secret: false, required: false, placeholder: 'optional, e.g. prod',
    pattern: PREFIX_PATTERN, patternHint: 'letters, digits, . _ / - only, no ".."',
  },
  {
    key: 'lockRules', label: 'Bucket lock rules', secret: false, required: false, multiline: true, json: true,
    placeholder: DEFAULT_LOCK_RULES,
    help: 'JSON with a top-level "rules" array, re-applied after each upload. Leave empty to keep whatever rules the bucket already has.',
  },
];

const AWS_FIELDS: FieldDef[] = [
  { key: 'accessKeyId', label: 'Access key ID', secret: true, required: true, placeholder: 'AKIA…' },
  { key: 'secretAccessKey', label: 'Secret access key', secret: true, required: true, placeholder: 'AWS secret access key' },
  {
    key: 'bucket', label: 'Default bucket', secret: false, required: true, placeholder: 'my-cloudflare-backups',
    pattern: BUCKET_PATTERN, patternHint: '3–63 lowercase letters, digits, dots or hyphens',
  },
  EXTRA_BUCKETS,
  {
    key: 'region', label: 'Region', secret: false, required: false, placeholder: 'blank = auto-detect',
    pattern: AWS_REGION_PATTERN, patternHint: 'an AWS region such as eu-west-1',
    help: 'Applies to the default bucket. For any other approved bucket the region is detected automatically.',
  },
];

/** Account-set field key of a storage field: r2 + bucket → r2Bucket. */
export const groupKey = (g: StorageKind, key: string) => `${g}${key[0].toUpperCase()}${key.slice(1)}`;
const grouped = (g: StorageKind, defs: FieldDef[]): FieldDef[] => defs.map((d) => ({ ...d, key: groupKey(g, d.key), group: g }));
const STORAGE_DEFS: Record<StorageKind, FieldDef[]> = { r2: R2_FIELDS, aws: AWS_FIELDS };

/** An account set's storage section as a plain R2 / AWS field map (null when it is not set up). */
export function storageFields(fields: Record<string, string | undefined>, g: StorageKind): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const d of STORAGE_DEFS[g]) { const v = fields[groupKey(g, d.key)]; if (v) out[d.key] = v; }
  return out.accessKeyId ? out : null;
}

/** The other way: a plain R2 / AWS field map as account-set fields. */
export function groupedFields(fields: Record<string, string>, g: StorageKind): Record<string, string> {
  return Object.fromEntries(STORAGE_DEFS[g].filter((d) => fields[d.key]).map((d) => [groupKey(g, d.key), fields[d.key]]));
}

export const KINDS: Record<CredentialKind, KindDef> = {
  cloudflare: {
    label: 'Account set',
    short: 'Account set',
    description: 'One Cloudflare account and the buckets its backups go to: the API token and account ID, plus R2 and/or AWS S3 (either can be left empty). Backups of this account can only go to these buckets, and restores only read from them.',
    fields: [
      {
        key: 'apiToken', label: 'API token', secret: true, required: true,
        placeholder: 'Paste token', help: 'My Profile › API Tokens › Create Token › "Read all resources".',
      },
      {
        key: 'accountId', label: 'Account ID', secret: false, required: true,
        placeholder: '32 hex characters', pattern: '^[0-9a-f]{32}$', patternHint: '32 lowercase hex characters',
        help: 'Dashboard › any zone › Overview (right sidebar).',
      },
      ...grouped('r2', R2_FIELDS),
      ...grouped('aws', AWS_FIELDS),
    ],
  },
  r2: {
    label: 'R2 access key (legacy)', short: 'R2 (legacy)', legacy: true, fields: R2_FIELDS,
    description: 'Saved before account sets. Move it into an account set to use it — runs no longer pick storage separately.',
  },
  aws: {
    label: 'AWS S3 access key (legacy)', short: 'AWS S3 (legacy)', legacy: true, fields: AWS_FIELDS,
    description: 'Saved before account sets. Move it into an account set to use it — runs no longer pick storage separately.',
  },
};

/** Listing order. Only account sets can be created. */
export const KIND_ORDER: CredentialKind[] = ['cloudflare', 'r2', 'aws'];

export interface FieldView {
  set: boolean;
  /** Full value for non-secret fields; never present for secret ones. */
  value?: string;
  /** Last characters of a secret, e.g. "…9f2c". */
  hint?: string;
}

export interface TestResult { ok: boolean; message: string; at: string }

/** What a non-vault user may know about a credential: enough to pick it for a backup. */
export interface CredentialOption {
  id: string;
  kind: CredentialKind;
  name: string;
  /** Result of the last connection test, null if never tested. */
  tested: boolean | null;
  /** Legacy R2 / AWS: their approved buckets, the default first. */
  buckets?: string[];
  /** Account set: the storage it has, each with the buckets a run may choose (default first). */
  storage?: Partial<Record<StorageKind, string[]>>;
}

export interface CredentialSummary {
  id: string;
  name: string;
  kind: CredentialKind;
  notes: string;
  fields: Record<string, FieldView>;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastTest?: TestResult;
}
