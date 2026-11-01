// Logpush jobs: how healthy each one is, what of its destination may be shown, and which changes
// the console may ask Cloudflare for. Shared by server and client — no Node imports.

import { compactNum } from '@/lib/num';

export type LogpushStatus = 'failing' | 'stale' | 'disabled' | 'waiting' | 'healthy';
export const LOGPUSH_STATUSES: LogpushStatus[] = ['failing', 'stale', 'disabled', 'waiting', 'healthy'];
/** Stored as the row's sort key, so the worst come first and a status filter uses the page index. */
export const STATUS_SORT: Record<LogpushStatus, number> = { failing: 0, stale: 1, disabled: 2, waiting: 3, healthy: 4 };
export const STATUS_LABEL: Record<LogpushStatus, string> = { failing: 'Failing', stale: 'Stale', disabled: 'Turned off', waiting: 'Not pushed yet', healthy: 'Healthy' };
/** A job that pushed nothing for this long is stale (a zone without traffic can be, too). */
export const STALE_HOURS = 24;

/** A job as Cloudflare answers GET …/logpush/jobs. */
export interface RawJob {
  id: number;
  name?: string | null;
  dataset?: string | null;
  enabled?: boolean;
  kind?: string | null;
  destination_conf?: string | null;
  filter?: string | null;
  frequency?: string | null;
  logpull_options?: string | null;
  output_options?: Record<string, unknown> | null;
  max_upload_bytes?: number | null;
  max_upload_interval_seconds?: number | null;
  max_upload_records?: number | null;
  last_complete?: string | null;
  last_error?: string | null;
  error_message?: string | null;
}

/** Failing: an error newer than the last push. Stale: no push for STALE_HOURS. Disabled first. */
export function jobStatus(j: Pick<RawJob, 'enabled' | 'last_complete' | 'last_error'>, now = Date.now(), staleHours = STALE_HOURS): LogpushStatus {
  if (!j.enabled) return 'disabled';
  const done = Date.parse(j.last_complete ?? '');
  const err = Date.parse(j.last_error ?? '');
  if (Number.isFinite(err) && (!Number.isFinite(done) || err > done)) return 'failing';
  if (!Number.isFinite(done)) return 'waiting';
  return now - done > staleHours * 3_600_000 ? 'stale' : 'healthy';
}

/**
 * The destination's scheme and host only: "s3://my-bucket", "https://logs.example.com". Everything
 * after the host (paths with tokens, ?access-key-id=…&secret-access-key=…, SAS tokens, headers) and
 * any user:password@ before it are dropped.
 */
export function redactDestination(conf: string | null | undefined): string {
  const m = /^([a-z][a-z0-9+.-]{0,30}):\/\/([^/?#\s]*)/i.exec((conf ?? '').trim());
  if (!m) return conf ? '(hidden)' : '';
  const host = m[2].replace(/^.*@/, '').slice(0, 253);
  return `${m[1].toLowerCase()}://${host}`;
}

const SECRET_PARAM = /\b((?:[a-z0-9_-]*(?:access[-_]?key|secret|sas|token|sig|signature|password|passwd|api[-_]?key|auth|credential)[a-z0-9_-]*)|header_[^=&\s]+)=[^&\s"'<>]+/gi;
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s"'<>]+/gi;

/** Cloudflare's error text with URLs cut to their host and secret-looking parameters blanked. */
export function scrubText(s: string | null | undefined, max = 500): string {
  if (!s) return '';
  return s.replace(URL_IN_TEXT, (u) => redactDestination(u)).replace(SECRET_PARAM, '$1=••••').slice(0, max);
}

/** Datasets offered when creating a job (Cloudflare lists more; any lower-case name is accepted). */
export const ZONE_DATASETS = ['http_requests', 'firewall_events', 'dns_logs', 'nel_reports', 'page_shield_events', 'spectrum_events', 'zaraz_events'];
export const ACCOUNT_DATASETS = ['audit_logs', 'audit_logs_v2', 'access_requests', 'gateway_dns', 'gateway_http', 'gateway_network', 'workers_trace_events', 'network_analytics_logs', 'magic_ids_detections', 'zero_trust_network_sessions', 'device_posture_results', 'casb_findings', 'dns_firewall_logs', 'email_security_alerts', 'sinkhole_http_logs', 'ssh_logs', 'dlp_forensic_copies', 'ipsec_logs'];

// ── Changes the console may ask for ─────────────────────────────────────────

export interface LogpushChanges {
  name?: string;
  enabled?: boolean;
  /** A JSON filter ({"where": …}); '' removes it. */
  filter?: string;
  output_options?: Record<string, unknown> | null;
  frequency?: 'high' | 'low';
  max_upload_bytes?: number;
  max_upload_records?: number;
  max_upload_interval_seconds?: number;
  /** Create only. */
  dataset?: string;
  kind?: '' | 'edge';
  /** Secret: sealed in the approval, never shown. */
  destination_conf?: string;
  /** Secret: sealed in the approval, never shown. */
  ownership_challenge?: string;
}
export const SECRET_FIELDS = ['destination_conf', 'ownership_challenge'] as const;

const OUTPUT_KEYS = new Set(['output_type', 'batch_prefix', 'batch_suffix', 'record_prefix', 'record_suffix', 'record_template', 'record_delimiter', 'field_delimiter', 'field_names', 'timestamp_format', 'sample_rate', 'CVE-2021-44228']);
const TIMESTAMPS = ['unixnano', 'unix', 'rfc3339', 'rfc3339ms', 'rfc3339ns'];

export class ChangeError extends Error {}

/** Cloudflare's ranges for the batch limits: 0 turns one off. */
function ranged(v: unknown, label: string, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || (n !== 0 && (n < min || n > max))) throw new ChangeError(`${label} must be 0 (off) or between ${compactNum(min)} and ${compactNum(max)}`);
  return n;
}

/** Checks the fields a request sets. Unknown fields are refused, so nothing unexpected reaches Cloudflare. */
export function checkChanges(raw: unknown, op: 'create' | 'update'): LogpushChanges {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (typeof c !== 'object' || Array.isArray(c)) throw new ChangeError('changes must be an object');
  const out: LogpushChanges = {};
  for (const k of Object.keys(c)) {
    if (c[k] === undefined) continue;
    switch (k) {
      case 'name': {
        const s = String(c.name ?? '').trim();
        if (s.length > 512 || !/^[a-zA-Z0-9.\-]*$/.test(s)) throw new ChangeError('The name may use letters, digits, dots and dashes (up to 512)');
        out.name = s;
        break;
      }
      case 'enabled':
        if (typeof c.enabled !== 'boolean') throw new ChangeError('enabled must be true or false');
        out.enabled = c.enabled;
        break;
      case 'filter': {
        const s = String(c.filter ?? '').trim();
        if (s.length > 8192) throw new ChangeError('The filter is longer than 8,192 characters');
        if (s) {
          let f: unknown;
          try { f = JSON.parse(s); } catch { throw new ChangeError('The filter must be JSON, e.g. {"where":{"key":"ClientRequestHost","operator":"eq","value":"example.com"}}'); }
          if (!f || typeof f !== 'object' || !('where' in f)) throw new ChangeError('The filter needs a "where" clause');
        }
        out.filter = s;
        break;
      }
      case 'output_options': {
        if (c.output_options === null) { out.output_options = null; break; }
        const o = c.output_options as Record<string, unknown>;
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new ChangeError('output_options must be an object');
        if (JSON.stringify(o).length > 8192) throw new ChangeError('output_options is too large');
        for (const key of Object.keys(o)) if (!OUTPUT_KEYS.has(key)) throw new ChangeError(`Unknown output option “${key}”`);
        if (o.output_type !== undefined && o.output_type !== 'ndjson' && o.output_type !== 'csv') throw new ChangeError('output_type must be ndjson or csv');
        if (o.timestamp_format !== undefined && !TIMESTAMPS.includes(String(o.timestamp_format))) throw new ChangeError(`timestamp_format must be one of ${TIMESTAMPS.join(', ')}`);
        if (o.sample_rate !== undefined && !(typeof o.sample_rate === 'number' && o.sample_rate > 0 && o.sample_rate <= 1)) throw new ChangeError('sample_rate must be a number above 0 and at most 1');
        if (o.field_names !== undefined && !(Array.isArray(o.field_names) && o.field_names.length <= 500 && o.field_names.every((f) => typeof f === 'string' && /^[A-Za-z0-9_.]{1,100}$/.test(f)))) throw new ChangeError('field_names must be a list of field names');
        out.output_options = o;
        break;
      }
      case 'frequency':
        if (c.frequency !== 'high' && c.frequency !== 'low') throw new ChangeError('frequency must be high or low');
        out.frequency = c.frequency;
        break;
      case 'max_upload_bytes': out.max_upload_bytes = ranged(c[k], 'Max batch size (bytes)', 5_000_000, 1_000_000_000); break;
      case 'max_upload_records': out.max_upload_records = ranged(c[k], 'Max records per batch', 1_000, 1_000_000); break;
      case 'max_upload_interval_seconds': out.max_upload_interval_seconds = ranged(c[k], 'Max seconds between batches', 30, 300); break;
      case 'dataset': {
        if (op !== 'create') throw new ChangeError('The dataset of a job cannot be changed');
        const s = String(c.dataset ?? '').trim();
        if (!/^[a-z_]{1,64}$/.test(s)) throw new ChangeError('Choose a dataset');
        out.dataset = s;
        break;
      }
      case 'kind':
        if (op !== 'create') throw new ChangeError('The kind of a job cannot be changed');
        if (c.kind !== '' && c.kind !== 'edge') throw new ChangeError('kind must be empty or edge');
        out.kind = c.kind;
        break;
      case 'destination_conf': {
        const s = String(c.destination_conf ?? '').trim();
        if (!s) break;
        if (s.length > 4096 || !/^[a-z][a-z0-9+.-]{0,30}:\/\/\S+$/i.test(s)) throw new ChangeError('The destination must be a URI such as s3://bucket/path?region=us-east-1 (up to 4,096 characters)');
        out.destination_conf = s;
        break;
      }
      case 'ownership_challenge': {
        const s = String(c.ownership_challenge ?? '').trim();
        if (!s) break;
        if (s.length > 4096 || /\s/.test(s)) throw new ChangeError('The ownership challenge is the token from the file Cloudflare wrote to the destination');
        out.ownership_challenge = s;
        break;
      }
      default:
        throw new ChangeError(`“${k}” cannot be set from the console`);
    }
  }
  if (op === 'create') {
    if (!out.dataset) throw new ChangeError('Choose a dataset');
    if (!out.destination_conf) throw new ChangeError('Enter the destination');
  }
  return out;
}

/** What the approver sees of a job: no destination path or credentials, filters cut short. */
export function summarizeJob(j: Partial<RawJob> & { destination?: string }): Record<string, string> {
  const o = j.output_options ?? null;
  const out: Record<string, string> = {};
  if (j.name !== undefined) out.name = j.name || '—';
  if (j.enabled !== undefined) out.enabled = j.enabled ? 'on' : 'off';
  if (j.dataset !== undefined) out.dataset = j.dataset || '—';
  if (j.destination !== undefined || j.destination_conf !== undefined) out.destination = j.destination ?? redactDestination(j.destination_conf);
  if (j.filter !== undefined) out.filter = j.filter ? (j.filter.length > 200 ? `${j.filter.slice(0, 200)}…` : j.filter) : 'none';
  if (j.output_options !== undefined) out.output = o ? [o.output_type ?? 'ndjson', Array.isArray(o.field_names) ? `${o.field_names.length} fields` : '', typeof o.sample_rate === 'number' && o.sample_rate < 1 ? `${o.sample_rate * 100}% sampled` : '', o.timestamp_format ? `timestamps ${String(o.timestamp_format)}` : ''].filter(Boolean).join(' · ') : 'default';
  if (j.frequency !== undefined) out.frequency = j.frequency || '—';
  if (j.max_upload_bytes !== undefined) out.max_upload_bytes = j.max_upload_bytes ? `${Math.round(j.max_upload_bytes / 1e6)} MB` : 'off';
  if (j.max_upload_records !== undefined) out.max_upload_records = j.max_upload_records ? compactNum(j.max_upload_records) : 'off';
  if (j.max_upload_interval_seconds !== undefined) out.max_upload_interval_seconds = j.max_upload_interval_seconds ? `${j.max_upload_interval_seconds} s` : 'off';
  return out;
}

const FIELD_LABEL: Record<string, string> = { name: 'Name', enabled: 'Enabled', dataset: 'Dataset', destination: 'Destination', filter: 'Filter', output: 'Output', frequency: 'Frequency', max_upload_bytes: 'Max batch size', max_upload_records: 'Max records per batch', max_upload_interval_seconds: 'Max seconds between batches' };

/** "Dataset: http_requests" for each field. */
export function fieldLines(rec: Record<string, string>): string[] {
  return Object.entries(rec).map(([k, v]) => `${FIELD_LABEL[k] ?? k}: ${v}`);
}

/** "Enabled: on → off" for each field that changes. */
export function diffLines(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after).filter((k) => before[k] !== after[k]).map((k) => `${FIELD_LABEL[k] ?? k}: ${before[k] ?? '—'} → ${after[k]}`);
}

/** One stored row of the Logpush check (what the page lists). */
export interface LogpushRow {
  job: string;
  jobId: number;
  scope: 'Account' | 'Zone';
  scopeKind: 'account' | 'zone';
  scopeId: string;
  scopeName: string;
  accountId: string;
  accountName: string;
  dataset: string;
  destination: string;
  enabled: boolean;
  status: LogpushStatus;
  lastComplete: string | null;
  lastError: string | null;
  error: string;
  frequency: string;
  batch: string;
  output: string;
  filtered: boolean;
}
