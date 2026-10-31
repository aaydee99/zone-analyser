import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './http';
import { DATA_DIR } from './store';
import { db, must } from './supabase';
import { mirrorFile } from './state-mirror';

// Restore history: one record per restore, kept in data/restore-history/<id>.json and updated at every
// step (prepared, compared, planned, applying, applied / failed), so a restore stays visible after its
// session ends. Records hold no secrets: no token, no key, no attribute values — addresses and actions only.
// Restores from before these records existed are listed from the audit log.

const HISTORY_DIR = path.join(DATA_DIR, 'restore-history');
const LOG_LINES = 5000;
export const RESTORE_ID = /^[A-Za-z0-9_-]{8,32}$/;

export type RestoreOutcome = 'matched' | 'applied' | 'applied-unverified' | 'failed' | 'cancelled' | 'plan-failed' | 'running' | 'open' | 'not-applied' | 'interrupted';

export interface RestoreStep { at: string; step: string; by: string }

export interface RestoreRecord {
  id: string;
  /** Session state when last saved. */
  state: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  zone: { id: string; name: string };
  account: { id: string; credentialName: string };
  source: { kind: string; bucket: string; folder: string; backupTime: string };
  /** Audit-log changes since the backup, and how many were chosen to restore. */
  auditChanges: number;
  selected: number;
  /** "Compare everything" result, when it was run. */
  scan: { at: string; total: number; differs: number; missing: number; matches: number; unchecked: number; extra: number } | null;
  plan: { at: string; changes: { address: string; actions: string[]; api?: boolean }[]; hasReplace: boolean; hasDelete: boolean; noChanges: boolean } | null;
  appliedAt: string | null;
  appliedBy: string | null;
  verified: boolean | null;
  /** The last job that was cancelled, and by whom. */
  cancelled?: { job: string; by: string; at: string } | null;
  steps: RestoreStep[];
  log: string[];
  /** Listed from the audit log only (before restore records existed). */
  legacy?: boolean;
}

export type RestoreSummary = Omit<RestoreRecord, 'log' | 'steps' | 'plan'> & {
  outcome: RestoreOutcome;
  /** Changes in the reviewed plan (no-ops left out). */
  planned: number;
};

export interface RestoreHistory {
  restores: RestoreSummary[];
  /** Restores started and planned in the last 30 days. */
  prepared30: number;
  planned30: number;
}

const file = (id: string) => path.join(HISTORY_DIR, `${id}.json`);

/** Saves a restore's record (never throws: history must not break a restore). */
export function saveRecord(r: Omit<RestoreRecord, 'updatedAt'>) {
  if (!RESTORE_ID.test(r.id)) return;
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const tmp = `${file(r.id)}.${process.pid}.tmp`;
    const rec = { ...r, log: r.log.slice(-LOG_LINES), updatedAt: new Date().toISOString() };
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    fs.renameSync(tmp, file(r.id));
    remember(rec, fs.statSync(file(r.id)));
    mirrorFile(`restore-history/${r.id}.json`, rec);
  } catch (err) {
    console.error('[restore-history] could not save the record:', err instanceof Error ? err.message : err);
  }
}

function readRecord(id: string): RestoreRecord | null {
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8')) as RestoreRecord; } catch { return null; }
}

const BUSY = new Set(['scanning', 'planning', 'applying']);

/** Where a restore ended up. `live`: its session still exists (it can be continued in New restore). */
export function outcomeOf(r: Pick<RestoreRecord, 'state' | 'verified' | 'cancelled'>, live: boolean): RestoreOutcome {
  if (r.state === 'matched') return 'matched';
  if (r.state === 'applied') return r.verified ? 'applied' : 'applied-unverified';
  if (r.state === 'apply-failed') return r.cancelled?.job === 'applying' ? 'cancelled' : 'failed';
  if (r.state === 'plan-failed' && !live) return 'plan-failed';
  if (BUSY.has(r.state)) return live ? 'running' : 'interrupted';
  return live ? 'open' : 'not-applied';
}

/** What the list needs from a record: everything but its log, steps and plan. */
interface Brief { base: Omit<RestoreRecord, 'log' | 'steps' | 'plan'>; planned: number; hasPlan: boolean }

const brief = (r: RestoreRecord): Brief => {
  const { log: _l, steps: _s, plan, ...base } = r;
  return { base, planned: plan ? plan.changes.filter((c) => !c.actions.includes('no-op')).length : 0, hasPlan: !!plan };
};
const fromBrief = (b: Brief, live: boolean): RestoreSummary => ({ ...b.base, outcome: outcomeOf(b.base, live), planned: b.planned });
const summarize = (r: RestoreRecord, live: boolean): RestoreSummary => fromBrief(brief(r), live);

// The history page polls the list. Each record (with a log of up to 5,000 lines) is parsed again
// only when its file changed (size or mtime); otherwise its brief comes from memory. Legacy rows
// (audit log, before records existed) never change, so they are read once every few minutes.
interface Cached { mtimeMs: number; size: number; brief: Brief }
const LEGACY_TTL_MS = 5 * 60_000;
interface HistoryCache { files: Map<string, Cached>; legacy?: { at: number; rows: RestoreRecord[] } }
const gc = globalThis as unknown as { __restoreHistory?: HistoryCache };
const cache: HistoryCache = (gc.__restoreHistory ??= { files: new Map<string, Cached>() });

function remember(r: RestoreRecord, st: fs.Stats) {
  cache.files.set(r.id, { mtimeMs: st.mtimeMs, size: st.size, brief: brief(r) });
}

/** Briefs of every record on disk, reading only new or changed files. */
function recordBriefs(): Brief[] {
  let names: string[] = [];
  try { names = fs.readdirSync(HISTORY_DIR).filter((n) => n.endsWith('.json')); } catch { /* none yet */ }
  const seen = new Set<string>();
  const out: Brief[] = [];
  for (const n of names) {
    const id = n.slice(0, -5);
    if (!RESTORE_ID.test(id)) continue;
    seen.add(id);
    let st: fs.Stats;
    try { st = fs.statSync(file(id)); } catch { continue; }
    const hit = cache.files.get(id);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { out.push(hit.brief); continue; }
    const r = readRecord(id);
    if (!r) { cache.files.delete(id); continue; }
    remember(r, st);
    out.push(cache.files.get(id)!.brief);
  }
  for (const id of cache.files.keys()) if (!seen.has(id)) cache.files.delete(id);
  return out;
}

interface AuditRow { id: number; at: string; actor_email: string | null; action: string; target: string | null; details: Record<string, unknown> | null }

/** Applied or failed restores from before restore records existed (cached: they never change). */
async function legacyRestores(): Promise<RestoreRecord[]> {
  if (cache.legacy && Date.now() - cache.legacy.at < LEGACY_TTL_MS) return cache.legacy.rows;
  const rows = await readLegacy();
  cache.legacy = { at: Date.now(), rows };
  return rows;
}

async function readLegacy(): Promise<RestoreRecord[]> {
  const rows = must(await db().from('audit_log').select('id, at, actor_email, action, target, details').in('action', ['restore.applied', 'restore.apply_failed']).order('at', { ascending: false }).limit(200), 'Reading restore history') as AuditRow[];
  return rows.filter((r) => !r.details?.restoreId).map((r) => {
    const resources = Array.isArray(r.details?.resources) ? (r.details.resources as unknown[]).map(String) : [];
    return {
      id: `audit-${r.id}`, legacy: true, state: r.action === 'restore.applied' ? 'applied' : 'apply-failed',
      createdBy: r.actor_email ?? '', createdAt: r.at, updatedAt: r.at, zone: { id: '', name: r.target ?? '' }, account: { id: '', credentialName: '' },
      source: { kind: '', bucket: '', folder: String(r.details?.folder ?? ''), backupTime: '' }, auditChanges: 0, selected: resources.length, scan: null,
      plan: { at: r.at, changes: resources.map((a) => ({ address: a, actions: ['restore'] })), hasReplace: false, hasDelete: false, noChanges: !resources.length },
      appliedAt: r.action === 'restore.applied' ? r.at : null, appliedBy: r.actor_email, verified: r.action === 'restore.applied' ? r.details?.verified === true : null,
      steps: [{ at: r.at, step: r.action === 'restore.applied' ? 'Applied' : 'Apply failed', by: r.actor_email ?? '' }], log: [],
    };
  });
}

/** Every restore, newest first. `live`: ids of restore sessions that still exist. */
export async function restoreHistory(live: Set<string>): Promise<RestoreHistory> {
  const briefs = recordBriefs();
  const all = [...briefs.map((b) => fromBrief(b, live.has(b.base.id))), ...(await legacyRestores()).map((r) => summarize(r, false))]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const since = Date.now() - 30 * 86_400_000;
  const recent = briefs.filter((b) => Date.parse(b.base.createdAt) >= since);
  return { restores: all, prepared30: recent.length, planned30: recent.filter((b) => b.hasPlan).length };
}

/** One restore with its steps, plan and log. */
export async function restoreRecord(id: string, live: boolean): Promise<RestoreRecord & { outcome: RestoreOutcome; live: boolean }> {
  const r = id.startsWith('audit-') ? (await legacyRestores()).find((x) => x.id === id) ?? null : RESTORE_ID.test(id) ? readRecord(id) : null;
  if (!r) throw new HttpError(404, 'Restore not found');
  return { ...r, outcome: outcomeOf(r, live && !r.legacy), live: live && !r.legacy };
}
