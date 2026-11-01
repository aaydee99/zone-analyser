import 'server-only';
import { compactNum } from '../num';
import { cfOne } from '../cf-read';
import type { NewFinding } from '../monitor-store';
import type { Row } from '../monitor-types';
import { STATUS_LABEL, STATUS_SORT, STALE_HOURS, jobStatus, redactDestination, scrubText, type LogpushRow, type RawJob } from '../logpush-types';
import { Problems, readStat, type CheckDef, type UnitTarget, type UnitContext, type UnitResult } from './common';

// Logpush: every job of every account and zone, with whether it pushes. Failing (an error newer than
// the last push), stale (nothing pushed for STALE_HOURS), turned off. Destinations are stored as
// their host only. Managing jobs is an approved action (cf-actions.ts, the Logpush page).

const HOUR = 3_600_000;

function batch(j: RawJob) {
  const parts = [
    j.max_upload_bytes ? `${Math.round(j.max_upload_bytes / 1e6)} MB` : '',
    j.max_upload_records ? `${compactNum(j.max_upload_records)} records` : '',
    j.max_upload_interval_seconds ? `${j.max_upload_interval_seconds} s` : '',
  ].filter(Boolean);
  return parts.length ? `max ${parts.join(' · ')}` : j.frequency ? `${j.frequency} frequency` : 'default';
}

function output(j: RawJob) {
  const o = j.output_options;
  if (!o) return j.logpull_options ? 'logpull options' : 'default';
  return [String(o.output_type ?? 'ndjson'), Array.isArray(o.field_names) ? `${o.field_names.length} fields` : '', typeof o.sample_rate === 'number' && o.sample_rate < 1 ? `${Math.round(o.sample_rate * 1000) / 10}% sampled` : ''].filter(Boolean).join(' · ');
}

async function readScope(kind: 'account' | 'zone', t: UnitTarget, ctx: UnitContext): Promise<UnitResult> {
  const p = new Problems();
  const scopeName = (kind === 'zone' ? t.zoneName : t.accountName) || t.id;
  let jobs: RawJob[] = [];
  try {
    jobs = (await cfOne<RawJob[]>(t.token, `/${kind === 'zone' ? 'zones' : 'accounts'}/${t.id}/logpush/jobs`, ctx.signal)) ?? [];
  } catch (err) {
    p.skip('Logpush jobs', err);
  }
  if (!Array.isArray(jobs)) jobs = [];
  const now = Date.now();
  const rows: Row[] = [];
  const findings: NewFinding[] = [];
  const counts = { jobs: 0, failing: 0, stale: 0, disabled: 0, waiting: 0, healthy: 0 };
  const scope = kind === 'zone'
    ? { accountId: t.accountId, accountName: t.accountName || t.accountId, zoneId: t.id, zoneName: scopeName }
    : { accountId: t.accountId || t.id, accountName: scopeName };
  for (const j of jobs) {
    const status = jobStatus(j, now);
    counts.jobs++;
    counts[status]++;
    const label = j.name || `#${j.id}`;
    const row: LogpushRow = {
      job: label, jobId: j.id, scope: kind === 'zone' ? 'Zone' : 'Account', scopeKind: kind, scopeId: t.id, scopeName,
      accountId: scope.accountId, accountName: scope.accountName, dataset: j.dataset ?? '', destination: redactDestination(j.destination_conf),
      enabled: !!j.enabled, status, lastComplete: j.last_complete ?? null, lastError: j.last_error ?? null, error: scrubText(j.error_message, 300),
      frequency: j.frequency ?? '', batch: batch(j), output: output(j), filtered: !!j.filter,
    };
    rows.push({ ...row, statusLabel: STATUS_LABEL[status], _tone: status === 'failing' ? 'bad' : status === 'stale' || status === 'disabled' ? 'warn' : 'ok', _sort: STATUS_SORT[status] } as unknown as Row);
    const where = `${kind === 'zone' ? 'zone' : 'account'} ${scopeName}`;
    const key = `logpush:${kind}:${t.id}:${j.id}`;
    if (status === 'failing') {
      findings.push({ key: `${key}:failing`, severity: 'high', title: `Logpush job “${label}” (${j.dataset ?? '?'}) in ${where} is failing`, detail: `Last error ${j.last_error}${j.last_complete ? `, last push ${j.last_complete}` : ', never pushed'}. ${scrubText(j.error_message, 300)}`.trim(), ...scope });
    } else if (status === 'stale') {
      const h = Math.floor((now - Date.parse(j.last_complete!)) / HOUR);
      findings.push({ key: `${key}:stale`, severity: 'medium', title: `Logpush job “${label}” (${j.dataset ?? '?'}) in ${where} has pushed nothing for ${h} hours`, detail: `Last push ${j.last_complete}. A zone without traffic pushes nothing either; otherwise check the destination.`, ...scope });
    } else if (status === 'disabled') {
      findings.push({ key: `${key}:disabled`, severity: 'info', title: `Logpush job “${label}” (${j.dataset ?? '?'}) in ${where} is turned off`, detail: `Logs of ${j.dataset ?? 'this dataset'} are not sent to ${redactDestination(j.destination_conf) || 'its destination'}.`, ...scope });
    }
  }
  return { rows: { jobs: rows }, findings, complete: p.complete, problems: p.list, counts, idle: !jobs.length };
}

export const logpush: CheckDef = {
  id: 'logpush', main: 'account',
  // Account jobs every hour (the check's interval); each zone's every 6 hours, once a day without jobs.
  every: { zone: 6 }, idleHours: 24,
  units: {
    account: (t, ctx) => readScope('account', t, ctx),
    zone: (t, ctx) => readScope('zone', t, ctx),
  },
  sections: [
    { key: 'jobs', title: 'Logpush jobs', description: `Worst first. Stale: nothing pushed for ${STALE_HOURS} hours. Destinations are shown as their host only. Manage jobs on the Logpush page.`,
      columns: [{ key: 'job', label: 'Job', kind: 'mono' }, { key: 'scopeName', label: 'Account or zone' }, { key: 'dataset', label: 'Dataset', kind: 'mono' }, { key: 'destination', label: 'Destination', kind: 'mono' }, { key: 'statusLabel', label: 'Status', kind: 'status' }, { key: 'lastComplete', label: 'Last push', kind: 'date' }, { key: 'lastError', label: 'Last error', kind: 'date' }, { key: 'error', label: 'Error' }],
      empty: 'No Logpush jobs in the accounts and zones read.' },
  ],
  stats: (t) => [
    { label: 'Logpush jobs', value: t.counts.jobs ?? 0 },
    { label: 'Failing', value: t.counts.failing ?? 0, tone: t.counts.failing ? 'bad' : 'ok' },
    { label: 'Stale or off', value: (t.counts.stale ?? 0) + (t.counts.disabled ?? 0), tone: (t.counts.stale ?? 0) + (t.counts.disabled ?? 0) ? 'warn' : 'ok' },
    readStat(t, 'Accounts and zones read'),
  ],
};
