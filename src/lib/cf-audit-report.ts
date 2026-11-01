// Cloudflare audit-log report: types, periods and grouping. Shared by server and client — no Node imports.
import { CATEGORIES, CATEGORY_LABEL, type CategoryKey, type FieldChange } from './cf-classify';
import { compactNum } from '@/lib/num';

export { CATEGORIES, CATEGORY_LABEL, type CategoryKey, type FieldChange };

export type CfRange = 'day' | 'week' | 'month' | 'year' | 'custom';

export const CF_RANGES: { value: CfRange; label: string; days?: number }[] = [
  { value: 'day', label: 'Last 24 hours', days: 1 },
  { value: 'week', label: 'Last 7 days', days: 7 },
  { value: 'month', label: 'Last 30 days', days: 30 },
  { value: 'year', label: 'Last 12 months', days: 365 },
  { value: 'custom', label: 'Custom' },
];

/** Cloudflare keeps audit logs for 18 months. */
export const CF_RETENTION_DAYS = 548;

/**
 * Where the old values come from:
 *  - previous: the previous change to the same resource in this report
 *  - lookup:   not in this report — can be fetched from Cloudflare's Resource History
 *  - none:     nothing earlier exists (a creation)
 */
/** Where old values come from: the previous change in the period, Cloudflare Resource History, the newest backup, or still to look up. */
export type OldSource = 'previous' | 'history' | 'backup' | 'lookup' | 'none';

export interface CfChange {
  id: string;
  time: string;
  accountId: string;
  accountName: string;
  /** Empty for account-level changes. */
  zoneId: string;
  zoneName: string;
  category: CategoryKey;
  /** The specific feature, e.g. "WAF custom rules", "DNS records", "Setting: Ssl". */
  feature: string;
  /** Cloudflare's own product category label (audit-log product categories), when known. */
  officialCategory: string;
  product: string;
  resourceType: string;
  resourceId: string;
  /** What was changed: "A www.example.com", a rule description, a setting … */
  target: string;
  /** create | update | delete */
  actionType: string;
  /** success | failure */
  result: string;
  description: string;
  /** Field-level changes. Created: new only. Deleted: old only. Updated: old → new. */
  changes: FieldChange[];
  oldSource: OldSource;
  /** Where the old values of a delete were found ("Resource History: change of … by …", "backup …"). */
  oldNote?: string;
  actorEmail: string;
  actorType: string;
  /** dash | api_token | api_key | oauth … */
  actorContext: string;
  actorTokenName: string;
  actorIp: string;
  method: string;
  uri: string;
  status: number | null;
}

/** A zone added to, activated on, or removed from Cloudflare during the period. */
export interface CfZoneEvent {
  accountId: string;
  accountName: string;
  zoneId: string;
  zoneName: string;
  event: 'added' | 'activated' | 'removed';
  time: string;
  /** Current state from the zones API; empty for removed zones. */
  status: string;
  type: string;
  plan: string;
  createdOn: string;
  activatedOn: string;
  /** Who did it, when the audit log recorded it. */
  actor: string;
}

export interface CfAccountResult {
  accountId: string;
  accountName: string;
  credentialName: string;
  count: number;
  /** Audit entries left out: views/reads (backup runs, lookups), failed requests, cache purges. */
  ignored?: number;
  truncated: boolean;
  /** Set when this account's audit log could not be read; other accounts still report. */
  error?: string;
  /** Set when the zone list could not be read (onboarding then relies on the audit log only). */
  zonesError?: string;
}

export interface CfAuditReport {
  since: string;
  before: string;
  range: CfRange;
  accounts: CfAccountResult[];
  /** Newest first, across all accounts. */
  changes: CfChange[];
  /** Zones onboarded (added/activated) or removed during the period. */
  zoneEvents: CfZoneEvent[];
  /** When it was read from Cloudflare. */
  readAt?: string;
  /** Set when this came from the cache instead of a fresh read. */
  cachedIn?: 'redis' | 'memory';
}

export interface CfHistoryResult {
  changes: FieldChange[];
  previousTime: string | null;
  previousActor: string;
  /** Cloudflare's result_info.history_status: exact | approximate | unavailable */
  historyStatus: string;
}

// ── Labels ──────────────────────────────────────────────────────────────────

/** The changes the page shows for a search and a category (the CSV download uses the same filter). */
export function filterChanges(changes: CfChange[], query: string, category: CategoryKey | '' = ''): CfChange[] {
  const q = query.trim().toLowerCase();
  const searched = !q ? changes : changes.filter((c) => [changeTitle(c), changeSummary(c, 40), zoneLabel(c), CATEGORY_LABEL[c.category], c.feature, c.officialCategory, actorLabel(c), c.accountName, c.uri]
    .some((s) => (s ?? '').toLowerCase().includes(q)));
  return category ? searched.filter((c) => c.category === category) : searched;
}

export const zoneLabel = (c: Pick<CfChange, 'zoneName'>) => c.zoneName || 'Account-level';
export const actorLabel = (c: Pick<CfChange, 'actorEmail' | 'actorTokenName' | 'actorType'>) =>
  c.actorEmail || (c.actorTokenName ? `token “${c.actorTokenName}”` : c.actorType || 'unknown');

const CONTEXT_LABEL: Record<string, string> = { dash: 'dashboard', api_token: 'API token', api_key: 'API key', api: 'API', oauth: 'OAuth', origin_ca_key: 'Origin CA key' };
export const contextLabel = (c: string) => CONTEXT_LABEL[c] ?? c;

const VERB: Record<string, string> = { create: 'Created', update: 'Updated', delete: 'Deleted' };
/** "Updated DNS records: A www.example.com" */
export const changeTitle = (c: CfChange) => {
  const verb = VERB[c.actionType] ?? (c.actionType ? c.actionType[0].toUpperCase() + c.actionType.slice(1) : 'Changed');
  return `${verb} ${c.feature}${c.target ? `: ${c.target}` : ''}`;
};

/** "content: 192.0.2.1 → 192.0.2.9; proxied: false → true" (first few fields). */
export function changeSummary(c: Pick<CfChange, 'changes' | 'actionType'>, max = 3): string {
  const parts = c.changes.slice(0, max).map((f) =>
    f.old !== undefined && f.new !== undefined ? `${f.path}: ${f.old} → ${f.new}` : f.new !== undefined ? `${f.path}: ${f.new}` : `${f.path} (was ${f.old})`);
  const more = c.changes.length - max;
  return parts.join('; ') + (more > 0 ? `; +${more} more` : '');
}

// ── Grouping ────────────────────────────────────────────────────────────────

export interface Tally { total: number; create: number; update: number; delete: number; failed: number }
const emptyTally = (): Tally => ({ total: 0, create: 0, update: 0, delete: 0, failed: 0 });
function add(t: Tally, c: CfChange) {
  t.total++;
  if (c.actionType === 'create' || c.actionType === 'update' || c.actionType === 'delete') t[c.actionType]++;
  if (c.result === 'failure') t.failed++;
}
const ORDER = new Map(CATEGORIES.map((c, i) => [c.key, i]));

export interface CategoryGroup {
  category: CategoryKey;
  label: string;
  tally: Tally;
  /** Account + zone scopes touched, most changes first. */
  scopes: { key: string; zone: string; account: string; tally: Tally; changes: CfChange[] }[];
}

/** Category → account/zone → changes. Categories in the fixed order of CATEGORIES. */
export function byCategory(changes: CfChange[]): CategoryGroup[] {
  const map = new Map<CategoryKey, CategoryGroup>();
  for (const c of changes) {
    let g = map.get(c.category);
    if (!g) { g = { category: c.category, label: CATEGORY_LABEL[c.category], tally: emptyTally(), scopes: [] }; map.set(c.category, g); }
    add(g.tally, c);
    const key = `${c.accountId}/${c.zoneId || '-'}`;
    let s = g.scopes.find((x) => x.key === key);
    if (!s) { s = { key, zone: zoneLabel(c), account: c.accountName || c.accountId, tally: emptyTally(), changes: [] }; g.scopes.push(s); }
    add(s.tally, c);
    s.changes.push(c);
  }
  const groups = [...map.values()];
  for (const g of groups) g.scopes.sort((a, b) => b.tally.total - a.tally.total || a.zone.localeCompare(b.zone));
  return groups.sort((a, b) => (ORDER.get(a.category) ?? 99) - (ORDER.get(b.category) ?? 99));
}

export interface AccountGroup {
  accountId: string;
  accountName: string;
  tally: Tally;
  zones: { zoneId: string; label: string; tally: Tally; categories: { category: CategoryKey; label: string; tally: Tally; changes: CfChange[] }[] }[];
}

/** Account → zone (account-level first) → category → changes. */
export function byAccount(changes: CfChange[]): AccountGroup[] {
  const accounts = new Map<string, AccountGroup>();
  for (const c of changes) {
    let a = accounts.get(c.accountId);
    if (!a) { a = { accountId: c.accountId, accountName: c.accountName || c.accountId, tally: emptyTally(), zones: [] }; accounts.set(c.accountId, a); }
    add(a.tally, c);
    let z = a.zones.find((x) => x.zoneId === c.zoneId);
    if (!z) { z = { zoneId: c.zoneId, label: zoneLabel(c), tally: emptyTally(), categories: [] }; a.zones.push(z); }
    add(z.tally, c);
    let f = z.categories.find((x) => x.category === c.category);
    if (!f) { f = { category: c.category, label: CATEGORY_LABEL[c.category], tally: emptyTally(), changes: [] }; z.categories.push(f); }
    add(f.tally, c);
    f.changes.push(c);
  }
  const out = [...accounts.values()];
  for (const a of out) {
    a.zones.sort((x, y) => (x.zoneId ? 1 : 0) - (y.zoneId ? 1 : 0) || y.tally.total - x.tally.total || x.label.localeCompare(y.label));
    for (const z of a.zones) z.categories.sort((x, y) => (ORDER.get(x.category) ?? 99) - (ORDER.get(y.category) ?? 99));
  }
  return out.sort((x, y) => y.tally.total - x.tally.total);
}

export function totals(changes: CfChange[]) {
  const t = emptyTally();
  for (const c of changes) add(t, c);
  return {
    ...t,
    accounts: new Set(changes.map((c) => c.accountId)).size,
    zones: new Set(changes.filter((c) => c.zoneId).map((c) => c.zoneId)).size,
    categories: new Set(changes.map((c) => c.category)).size,
    people: new Set(changes.map(actorLabel)).size,
  };
}

// ── Export ──────────────────────────────────────────────────────────────────

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheets from running it as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per changed field (a change with no field detail still gets one row). */
export function toCsv(changes: CfChange[]): string {
  const head = ['time', 'account', 'zone', 'category', 'feature', 'action', 'target', 'field', 'old_value', 'new_value', 'result', 'actor', 'via', 'ip', 'method', 'uri', 'cloudflare_category'];
  const rows: unknown[][] = [];
  for (const c of changes) {
    const base = [c.time, c.accountName || c.accountId, zoneLabel(c), CATEGORY_LABEL[c.category], c.feature, c.actionType, c.target];
    const tail = [c.result, actorLabel(c), contextLabel(c.actorContext), c.actorIp, c.method, c.uri, c.officialCategory];
    if (!c.changes.length) rows.push([...base, '', '', '', ...tail]);
    for (const f of c.changes) rows.push([...base, f.path, f.old ?? '', f.new ?? '', ...tail]);
  }
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

const EVENT_LABEL = { added: 'added', activated: 'activated', removed: 'removed' } as const;

/** Plain-text summary by category, for pasting into a message or ticket. */
export function summaryText(r: CfAuditReport): string {
  const d = (iso: string) => new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const t = totals(r.changes);
  const lines = [
    `Cloudflare changes ${d(r.since)} → ${d(r.before)}`,
    `${compactNum(t.total)} changes · ${compactNum(t.accounts)} account(s) · ${compactNum(t.zones)} zone(s) · ${t.categories} categor${t.categories === 1 ? 'y' : 'ies'} · ${t.people} actor(s)`,
    '',
  ];
  if (r.zoneEvents.length) {
    lines.push('Zone onboarding:');
    for (const z of r.zoneEvents) lines.push(`  ${z.zoneName} [${z.accountName}] ${EVENT_LABEL[z.event]} ${d(z.time)}${z.status ? ` · status ${z.status}` : ''}${z.actor ? ` · by ${z.actor}` : ''}`);
    lines.push('');
  } else lines.push('Zone onboarding: no zones added or removed.', '');
  for (const g of byCategory(r.changes)) {
    lines.push(`${g.label}: ${compactNum(g.tally.total)} (${g.tally.create} created, ${g.tally.update} updated, ${g.tally.delete} deleted${g.tally.failed ? `, ${g.tally.failed} failed` : ''})`);
    for (const s of g.scopes) {
      lines.push(`  ${s.zone} [${s.account}]: ${compactNum(s.tally.total)}`);
      for (const c of s.changes.slice(0, 5)) {
        const sum = changeSummary(c, 2);
        lines.push(`    ${d(c.time)} ${changeTitle(c)}${sum ? ` — ${sum}` : ''} (${actorLabel(c)})`);
      }
      if (s.changes.length > 5) lines.push(`    … ${s.changes.length - 5} more`);
    }
  }
  for (const a of r.accounts) {
    if (a.error) lines.push('', `Not read — ${a.credentialName}: ${a.error}`);
    else if (a.truncated) lines.push('', `${a.accountName}: only the newest ${compactNum(a.count)} changes were read.`);
    if (a.zonesError) lines.push('', `${a.accountName || a.credentialName}: zone list not read — ${a.zonesError}`);
  }
  return lines.join('\n');
}
