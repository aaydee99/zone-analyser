// Turns audit-log entries into a readable change report. Shared by server and client — no Node imports.
import { KINDS, type CredentialKind } from './kinds';
import { BRAND } from '@/lib/brand';
import { ROLE_META, isRole } from './rbac';

export interface AuditEntry {
  id: number;
  at: string;
  actorEmail: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
}

export type ChangeArea = 'users' | 'credentials' | 'presets' | 'settings' | 'runs' | 'approvals' | 'account';

export const AREA_LABEL: Record<ChangeArea, string> = {
  users: 'Users & roles',
  credentials: 'Credentials & vault',
  presets: 'Presets',
  settings: 'Settings & tools',
  runs: 'Runs',
  approvals: 'Approvals',
  account: 'Accounts',
};

/** Actions that change the console's state. Everything else (sign-ins, downloads, reveals…) is activity. */
export const CHANGE_AREA: Record<string, ChangeArea> = {
  'setup.super_admin_created': 'users',
  'user.created': 'users',
  'user.updated': 'users',
  'user.deleted': 'users',
  'vault.created': 'credentials',
  'vault.password_changed': 'credentials',
  'vault.server_key_resealed': 'credentials',
  'vault.password_reset': 'credentials',
  'vault.password_cleared': 'credentials',
  'vault.reset': 'credentials',
  'credential.created': 'credentials',
  'credential.updated': 'credentials',
  'credential.deleted': 'credentials',
  'credential.storage_attached': 'credentials',
  'preset.created': 'presets',
  'preset.updated': 'presets',
  'preset.deleted': 'presets',
  'settings.updated': 'settings',
  'tool.installed': 'settings',
  'tool.removed': 'settings',
  'run.deleted': 'runs',
  'approval.approved': 'approvals',
  'approval.rejected': 'approvals',
  'auth.password_changed': 'account',
  'zone_meta.updated': 'settings',
  'zone_meta.bulk_updated': 'settings',
  'zone_meta.tag_renamed': 'settings',
  'zone_meta.tag_removed': 'settings',
  'zone_meta.imported': 'settings',
  'report.created': 'settings',
  'report.updated': 'settings',
  'report.deleted': 'settings',
  'slack.user_linked': 'settings',
  'slack.user_unlinked': 'settings',
  'compare.template_created': 'settings',
  'compare.template_updated': 'settings',
  'compare.template_deleted': 'settings',
  'api_query.saved': 'presets',
  'api_query.deleted': 'presets',
};

export const CHANGE_ACTIONS = Object.keys(CHANGE_AREA);

/** Activity counted (not listed) in the report, with the label it is shown under. */
export const ACTIVITY: { key: string; label: string; actions: string[]; tone?: 'bad' | 'warn' }[] = [
  { key: 'signIns', label: 'Sign-ins', actions: ['auth.login'] },
  { key: 'failedSignIns', label: 'Failed sign-ins', actions: ['auth.login_failed', 'auth.login_denied'], tone: 'bad' },
  { key: 'runsStarted', label: 'Backups started', actions: ['run.started'] },
  { key: 'approvalRequests', label: 'Approval requests', actions: ['approval.requested'] },
  { key: 'approvalsWithdrawn', label: 'Requests withdrawn or expired', actions: ['approval.withdrawn', 'approval.expired', 'approval.failed'], tone: 'warn' },
  { key: 'runsCancelled', label: 'Backups cancelled', actions: ['run.cancelled'] },
  { key: 'downloads', label: 'Backups downloaded', actions: ['run.downloaded'] },
  { key: 'vaultUnlocks', label: 'Vault unlocks', actions: ['vault.unlocked'] },
  { key: 'vaultUnlockFailures', label: 'Failed vault unlocks', actions: ['vault.unlock_failed'], tone: 'bad' },
  { key: 'reveals', label: 'Secrets revealed', actions: ['credential.revealed'], tone: 'warn' },
  { key: 'credentialTests', label: 'Credential tests', actions: ['credential.tested'] },
  { key: 'cloudflareReverts', label: 'Cloudflare changes reverted', actions: ['cloudflare.reverted'], tone: 'warn' },
  { key: 'apiQueries', label: 'API console reads', actions: ['cloudflare.query'] },
  { key: 'workerTails', label: 'Live Worker log sessions', actions: ['worker_tail.started'] },
  { key: 'logpushOwnership', label: 'Logpush ownership challenges', actions: ['logpush.ownership_requested', 'logpush.ownership_failed'] },
];

export interface ChangeReport {
  since: string;
  until: string;
  days: number;
  /** True when the window held more entries than the server reads in one report. */
  truncated: boolean;
  /** Newest first. */
  changes: AuditEntry[];
  activity: Record<string, number>;
  /** Who made changes, most first. */
  people: { email: string; changes: number }[];
}

export function buildReport(entries: AuditEntry[], since: Date, until: Date, days: number, truncated: boolean): ChangeReport {
  const changes = entries.filter((e) => e.action in CHANGE_AREA);
  const activity: Record<string, number> = {};
  for (const a of ACTIVITY) activity[a.key] = entries.filter((e) => a.actions.includes(e.action)).length;
  const byPerson = new Map<string, number>();
  for (const c of changes) {
    const who = c.actorEmail ?? 'unknown';
    byPerson.set(who, (byPerson.get(who) ?? 0) + 1);
  }
  const people = [...byPerson].map(([email, n]) => ({ email, changes: n })).sort((a, b) => b.changes - a.changes || a.email.localeCompare(b.email));
  return { since: since.toISOString(), until: until.toISOString(), days, truncated, changes, activity, people };
}

// ── Sentences ───────────────────────────────────────────────────────────────

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v));
const role = (v: unknown) => (isRole(v) ? ROLE_META[v].label.toLowerCase() : str(v) || 'unknown role');
const kind = (v: unknown) => (typeof v === 'string' && v in KINDS ? KINDS[v as CredentialKind].short : str(v) || 'unknown');
/** "account set" for account sets, "<kind> credential" for the legacy storage-only ones. */
const credNoun = (v: unknown) => (v === 'cloudflare' ? 'account set' : `${kind(v)} credential`);
const q = (v: unknown) => `“${str(v)}”`;

const SETTING_LABEL: Record<string, (v: unknown) => string> = {
  sessionIdleMinutes: (v) => `session timeout → ${str(v)} min`,
  vaultAutoLockMinutes: (v) => `vault auto-lock → ${str(v)} min`,
  outputDir: (v) => `default output folder → ${str(v) || 'default'}`,
  pluginCacheDir: (v) => `plugin cache folder → ${str(v) || 'default'}`,
  requireReason: (v) => `reason required on approval requests → ${v ? 'yes' : 'no'}`,
};

/** One plain-language line for a change entry, without the actor (shown separately). */
export function describeChange(e: AuditEntry): string {
  const d = e.details ?? {};
  switch (e.action) {
    case 'setup.super_admin_created': return `Created the first super admin ${str(e.target)}`;
    case 'user.created': return `Added ${str(e.target)} as ${role(d.role)}`;
    case 'user.deleted': return `Removed ${str(e.target)} (was ${role(d.role)})`;
    case 'user.updated': {
      const parts: string[] = [];
      const r = d.role as { from?: unknown; to?: unknown } | undefined;
      if (r && typeof r === 'object') parts.push(`role ${role(r.from)} → ${role(r.to)}`);
      if ('disabled' in d) parts.push(d.disabled ? 'disabled the account' : 're-enabled the account');
      if ('password' in d) parts.push('reset the password');
      if ('name' in d) parts.push(`name → ${q(d.name)}`);
      return `Changed ${str(e.target)}: ${parts.join(', ') || 'profile updated'}`;
    }
    case 'vault.created': return 'Created the credential vault';
    case 'vault.password_changed': return 'Changed the vault password';
    case 'vault.server_key_resealed': return 'Re-sealed the vault for a new server key';
    case 'vault.reset': return 'Deleted the vault and every stored credential (reset script)';
    case 'vault.password_cleared': return 'Cleared the vault password in the database (reset script)';
    case 'vault.password_reset': return 'Set a new vault password after a reset (credentials unchanged)';
    case 'credential.created': return `Added ${credNoun(d.kind)} ${q(e.target)}`;
    case 'credential.deleted': return `Deleted ${credNoun(d.kind)} ${q(e.target)}`;
    case 'credential.storage_attached': return `Moved ${q(d.from)} into account set ${q(e.target)}`;
    case 'credential.updated': {
      const s = Array.isArray(d.secretsChanged) ? d.secretsChanged.map(str).filter(Boolean) : [];
      return `Edited credential ${q(e.target)}${s.length ? ` — secrets replaced: ${s.join(', ')}` : ''}`;
    }
    case 'preset.created': return `Created preset ${q(e.target)}`;
    case 'preset.updated': return `Updated preset ${q(e.target)}`;
    case 'preset.deleted': return `Deleted preset ${q(e.target)}`;
    case 'settings.updated': {
      const parts = Object.entries(d).filter(([k]) => k in SETTING_LABEL).map(([k, v]) => SETTING_LABEL[k](v));
      return `Changed settings: ${parts.join(', ') || 'no effective change'}`;
    }
    case 'tool.installed': return `Installed ${str(e.target)}${d.version ? ` v${str(d.version)}` : ''}`;
    case 'tool.removed': return `Removed the managed copy of ${str(e.target)}`;
    case 'run.deleted': return `Deleted run ${str(e.target)}`;
    case 'approval.approved': return `Approved ${d.kind === 'restore' ? 'a restore apply' : d.kind === 'cloudflare' ? 'a Cloudflare change' : 'a backup'} asked by ${str(d.requestedBy)}: ${str(e.target)}${d.runId ? ` (run ${str(d.runId)})` : ''}`;
    case 'approval.rejected': return `Rejected ${d.kind === 'restore' ? 'a restore apply' : d.kind === 'cloudflare' ? 'a Cloudflare change' : 'a backup'} asked by ${str(d.requestedBy)}: ${str(e.target)}${d.reason ? ` — ${str(d.reason)}` : ''}`;
    case 'auth.password_changed': return 'Changed their own sign-in password';
    case 'cloudflare.action': return `Changed Cloudflare: ${str(d.result)}`;
    case 'cloudflare.action_failed': return `Cloudflare refused: ${str(e.target)} — ${str(d.error)}`;
    case 'monitoring.ran': return `Ran monitoring checks (${Array.isArray(d.checks) ? d.checks.length : 0}) — ${str(d.newFindings)} new findings`;
    case 'monitoring.run_requested': return `Started monitoring checks (${Array.isArray(d.checks) ? d.checks.length : 0}) — ${str(d.units)} zones and accounts to read`;
    case 'monitoring.finding_dismissed': return `Dismissed a finding: ${str(e.target)}`;
    case 'monitoring.finding_restored': return `Brought back a dismissed finding: ${str(e.target)}`;
    case 'monitoring.settings_updated': return 'Changed the monitoring schedule or notifications';
    case 'monitoring.baseline_accepted': return `Accepted the current state as the drift baseline: ${str(e.target)}`;
    case 'monitoring.inbox_connected': return `Connected Cloudflare alerts to the console: ${str(e.target)}`;
    case 'cloudflare.reverted': return `Reverted a Cloudflare change in ${str(e.target)}: ${str(d.summary)} (${str(d.method)} ${str(d.path)}, key of ${str(d.keyEmail)})`;
    case 'cloudflare.revert_failed': return `Cloudflare refused a revert in ${str(e.target)}: ${str(d.summary)} — ${str(d.error)}`;
    case 'security.denied': return `Was refused ${str(d.method)} ${str(e.target)} (${str(d.reason)})`;
    case 'security.rate_limited': return `Was rate limited on ${str(d.method)} ${str(e.target)}`;
    case 'compare.template_created': return `Created the comparison template ${q(e.target)} (${str(d.items)} items${d.fromZone ? ` from ${str(d.fromZone)}` : ''})`;
    case 'compare.template_updated': return `Changed the comparison template ${q(e.target)}: ${Array.isArray(d.changed) ? d.changed.map(str).join(', ') : 'updated'}`;
    case 'compare.template_deleted': return `Deleted the comparison template ${q(e.target)}`;
    case 'search.index_rebuilt': return 'Rebuilt the zone search index';
    case 'zone_meta.updated': return `Changed the tags or owner of ${str(e.target)}${Array.isArray((d.tags as { to?: unknown } | undefined)?.to) ? ` — tags ${((d.tags as { to: unknown[] }).to.map(str).join(', ')) || 'none'}` : ''}`;
    case 'zone_meta.bulk_updated': return `Tagged ${str(d.zones)} zones${Array.isArray(d.add) && d.add.length ? ` +${d.add.map(str).join(' +')}` : ''}${Array.isArray(d.remove) && d.remove.length ? ` −${d.remove.map(str).join(' −')}` : ''}${typeof d.owner === 'string' ? ` · owner → ${q(d.owner)}` : ''}`;
    case 'zone_meta.tag_renamed': return `Renamed the zone tag ${q(d.from)} to ${q(d.to)} on ${str(d.zones)} zones`;
    case 'zone_meta.tag_removed': return `Removed the zone tag ${q(d.from)} from ${str(d.zones)} zones`;
    case 'zone_meta.imported': return `Imported zone tags and owners from CSV: ${str(d.changed)} zones changed`;
    case 'api_query.saved': return `Saved the API console query ${q(e.target)}: ${str(d.path)}`;
    case 'api_query.deleted': return `Deleted the API console query ${q(e.target)}`;
    case 'cloudflare.query': return `Read GET ${str(e.target)} with ${q(d.credential)} (HTTP ${str(d.status)})`;
    case 'worker_tail.started': return `Started following the logs of Worker ${str(e.target)}`;
    case 'worker_tail.stopped': return `Stopped following the logs of Worker ${str(e.target)} (${str(d.events)} events)`;
    case 'logpush.ownership_requested': return `Asked Cloudflare for a Logpush ownership challenge in ${str(e.target)} (${str(d.destination)})`;
    case 'logpush.ownership_failed': return `Cloudflare refused a Logpush ownership challenge in ${str(e.target)}: ${str(d.error)}`;
    default: return `${e.action}${e.target ? ` ${e.target}` : ''}`;
  }
}

/** Plain-text version of the report, for pasting into a message or ticket. */
export function reportText(r: ChangeReport): string {
  const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const lines = [`${BRAND.name} — changes from ${day(r.since)} to ${day(r.until)} (${r.days} day${r.days === 1 ? '' : 's'})`, ''];
  if (!r.changes.length) lines.push('No changes recorded.');
  let current = '';
  for (const c of r.changes) {
    const d = day(c.at);
    if (d !== current) { if (current) lines.push(''); lines.push(d); current = d; }
    lines.push(`  ${time(c.at)}  ${c.actorEmail ?? 'unknown'} — ${describeChange(c)}`);
  }
  lines.push('', 'Activity:');
  for (const a of ACTIVITY) lines.push(`  ${a.label}: ${r.activity[a.key] ?? 0}`);
  if (r.truncated) lines.push('', 'Note: the period had more entries than one report reads; older ones are not included.');
  return lines.join('\n');
}
