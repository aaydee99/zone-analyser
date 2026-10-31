import 'server-only';
import { BudgetError, MONITOR_BUDGET, asMonitor, laneOf, laneUse, setLanePause, type MonitorCalls } from './cf-read';
import { credentialForRun, listCredentialOptions } from './vault';
import { tokenAccounts } from './providers';
import { listZones } from './zone-explorer';
import { db } from './supabase';
import { HttpError } from './http';
import { consoleRole } from './worker-link';
import { getMonitorConfig, type MonitorConfig } from './monitor-config';
import { forgetUnits, must, readState, saveResult, syncFindings, type ScopeKind, type UnitKey } from './monitor-store';
import { sendUnsent } from './notify';
import { activeRunCredentialId } from './runner';
import { activeRestore } from './job-lock';
import type { CheckId, LaneView, QueueView } from './monitor-types';
import { DEFS } from './checks';
import type { CheckDef, UnitResult, UnitTarget } from './checks/common';

// The monitoring queue. Every check is split into units — one per zone, per account, or one for the
// whole console — each a row in monitor_targets with its own next run. The worker takes the units
// that are due, worst-overdue first and hand-started ones before all others, and runs them in
// "lanes": one per stored API token, each with its own share of Cloudflare's rate limit
// (MONITOR_BUDGET calls per 5 minutes, see cf-read.ts) and a few units at a time. Tokens therefore
// work side by side, a slow or rate-limited account only delays its own lane, and a token a backup
// or restore is using gets no monitoring calls until it is done. Nothing is lost when the worker
// stops: what is due stays due in the table, and the next worker carries on.

/** Units running at once, over all lanes, and per lane. */
const MAX_RUNNING = Math.max(1, Number(process.env.MONITOR_PARALLEL) || 24);
const PER_LANE = 6;
/** How often the queue looks for due units (a finished unit looks again at once). */
const TICK_MS = Math.max(200, Number(process.env.MONITOR_TICK_MS) || 5_000);
/** Accounts and zones are listed again this often (and when someone starts checks by hand). */
const DISCOVER_MS = 6 * 3_600_000;
const DISCOVER_ON_RUN_MS = 10 * 60_000;
/** New findings are sent at most this often while units run, and as soon as the queue is empty. */
const NOTIFY_MS = Math.max(1_000, Number(process.env.MONITOR_NOTIFY_SECONDS) * 1000 || 5 * 60_000);
/** A unit whose worker stopped mid-run is taken again after this. */
const LEASE_MS = 15 * 60_000;
const HOUR = 3_600_000;

/** Calls a unit of each kind takes before the first run tells (then its last run's count is used). */
const FIRST_COST: Record<CheckId, Partial<Record<ScopeKind, number>>> = {
  posture: { account: 1 }, certificates: { zone: 4, account: 1 }, governance: { account: 2, global: 3 }, drift: { account: 1, zone: 26 },
  alerts: { account: 3, global: 0 }, availability: { zone: 2, account: 2 }, platform: { account: 6 }, appsec: { zone: 4 }, pagerules: { zone: 1 },
};

interface Lane { key: string; token: string; names: string[]; credentialIds: Set<string>; accounts: number; zones: number }
interface Scope { name: string; accountId: string; accountName: string; lanes: string[]; /** Named after its credential until Cloudflare gives its name. */ guessed?: boolean }
interface World { at: number; print: string; lanes: Map<string, Lane>; laneOfCredential: Map<string, string>; accounts: Map<string, Scope>; zones: Map<string, Scope>; problems: string[] }
interface Running { lane: string; est: number; calls: MonitorCalls }
interface TargetRow {
  check_id: CheckId; scope_kind: ScopeKind; scope_id: string; account_id: string | null; account_name: string | null; zone_name: string | null;
  next_due_at: string; priority: number; lease_until: string | null; last_ok_at: string | null; fail_count: number; cost: number | null;
}

const g = globalThis as unknown as {
  __monitorQueue?: {
    started: boolean; ticking: boolean; world: World | null; printAt: number; discovering: Promise<World> | null; rediscover: boolean;
    running: Map<string, Running>; due: number; note: string | null; unsent: boolean; lastSent: number; timer: ReturnType<typeof setTimeout> | null;
  };
};
const q = (g.__monitorQueue ??= { started: false, ticking: false, world: null, printAt: 0, discovering: null, rediscover: false, running: new Map(), due: 0, note: null, unsent: true, lastSent: 0, timer: null });

const unitKey = (r: { check_id: string; scope_kind: string; scope_id: string }) => `${r.check_id}:${r.scope_kind}:${r.scope_id}`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const log = (msg: string) => console.log(`[monitoring] ${msg}`);

// ── Accounts, zones and the tokens that read them ───────────────────────────

/** The stored Cloudflare credentials and their tokens, as one string: it changes when one is added, removed or given a new token. */
async function credentialPrint(): Promise<string> {
  const parts: string[] = [];
  for (const o of (await listCredentialOptions()).filter((x) => x.kind === 'cloudflare')) {
    let t = '';
    try { t = laneOf((await credentialForRun(o.id, 'cloudflare')).fields.apiToken ?? ''); } catch { /* unreadable: listed without a token */ }
    parts.push(`${o.id}:${t}`);
  }
  return parts.sort().join(',');
}

async function discover(): Promise<World> {
  const print = await credentialPrint();
  const lanes = new Map<string, Lane>();
  const laneOfCredential = new Map<string, string>();
  const accounts = new Map<string, Scope>();
  const zones = new Map<string, Scope>();
  const problems: string[] = [];
  const addLane = (scope: Scope, lane: string) => { if (!scope.lanes.includes(lane)) scope.lanes.push(lane); };
  for (const o of (await listCredentialOptions()).filter((x) => x.kind === 'cloudflare')) {
    try {
      const c = await credentialForRun(o.id, 'cloudflare');
      const token = c.fields.apiToken;
      if (!token) continue;
      const key = laneOf(token);
      const lane = lanes.get(key) ?? { key, token, names: [], credentialIds: new Set<string>(), accounts: 0, zones: 0 };
      if (!lane.names.includes(o.name)) lane.names.push(o.name);
      lane.credentialIds.add(o.id);
      lanes.set(key, lane);
      laneOfCredential.set(o.id, key);
      // A credential set to one account has no account name from Cloudflare: it is known by the credential's.
      const fixed = !!c.fields.accountId?.trim();
      for (const a of await tokenAccounts(c)) {
        const name = a.name || (fixed ? o.name : '');
        const s = accounts.get(a.id) ?? { name, accountId: a.id, accountName: name, lanes: [], guessed: !a.name };
        if (a.name && (!s.name || s.guessed)) { s.name = s.accountName = a.name; s.guessed = false; }
        addLane(s, key);
        accounts.set(a.id, s);
      }
    } catch (err) {
      problems.push(`Credential “${o.name}”: ${message(err)}`);
    }
  }
  const list = await listZones(true);
  problems.push(...list.problems.map((p) => `Credential “${p.credential}”: ${p.error}`));
  for (const z of list.zones) {
    const zl = (list.readersOf[z.id] ?? []).map((id) => laneOfCredential.get(id)).filter((x): x is string => !!x);
    if (!zl.length) continue;
    zones.set(z.id, { name: z.name, accountId: z.accountId, accountName: z.accountName, lanes: [...new Set(zl)] });
    const a = z.accountId ? accounts.get(z.accountId) : undefined;
    if (a && z.accountName && (!a.accountName || a.guessed)) { a.name = a.accountName = z.accountName; a.guessed = false; }
  }
  for (const s of accounts.values()) for (const l of s.lanes) lanes.get(l)!.accounts++;
  for (const s of zones.values()) for (const l of s.lanes) lanes.get(l)!.zones++;
  const world: World = { at: Date.now(), print, lanes, laneOfCredential, accounts, zones, problems };
  await syncTargets(world);
  log(`${accounts.size} accounts and ${zones.size} zones over ${lanes.size} token${lanes.size === 1 ? '' : 's'}${problems.length ? ` (${problems.length} problem${problems.length === 1 ? '' : 's'})` : ''}`);
  return world;
}

/** Lists the accounts and zones again (once at a time). */
function rediscover(): Promise<World> {
  q.discovering ??= discover().then((w) => { q.world = w; q.rediscover = false; return w; }).finally(() => { q.discovering = null; });
  return q.discovering;
}

/**
 * The accounts and zones to check. Listing thousands of zones takes a while, so an old list is
 * replaced in the background while the queue keeps working with it; only the very first is waited for.
 */
async function world(): Promise<World> {
  if (!q.world) return rediscover();
  // A credential added, removed or given a new token: list again (and wait, when there was none before).
  if (Date.now() - q.printAt > 60_000) {
    q.printAt = Date.now();
    if ((await credentialPrint()) !== q.world.print) {
      if (!q.world.lanes.size) return rediscover();
      q.rediscover = true;
    }
  }
  if (q.rediscover || Date.now() - q.world.at > DISCOVER_MS) void rediscover().catch((err) => log(`listing accounts and zones failed: ${message(err)}`));
  return q.world;
}

/** Adds a unit for every check and new zone or account; removes the units of ones no token reaches any more. */
async function syncTargets(w: World) {
  const want = new Map<string, Record<string, unknown>>();
  for (const def of Object.values(DEFS)) {
    for (const kind of Object.keys(def.units) as ScopeKind[]) {
      if (kind === 'global') want.set(`${def.id}:global:*`, { check_id: def.id, scope_kind: 'global', scope_id: '*', account_id: null, account_name: null, zone_name: null });
      const scopes = kind === 'zone' ? w.zones : kind === 'account' ? w.accounts : null;
      for (const [id, s] of scopes ?? []) {
        want.set(`${def.id}:${kind}:${id}`, { check_id: def.id, scope_kind: kind, scope_id: id, account_id: s.accountId, account_name: s.accountName || null, zone_name: kind === 'zone' ? s.name : null });
      }
    }
  }
  const have = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const rows = must(await db().from('monitor_targets').select('check_id, scope_kind, scope_id').order('check_id').order('scope_kind').order('scope_id').range(from, from + 999), 'Reading monitoring targets') as TargetRow[];
    for (const r of rows) have.add(unitKey(r));
    if (rows.length < 1000) break;
  }
  const add = [...want].filter(([k]) => !have.has(k)).map(([, row]) => row);
  for (let i = 0; i < add.length; i += 500) must(await db().from('monitor_targets').upsert(add.slice(i, i + 500), { ignoreDuplicates: true }), 'Adding monitoring targets');
  // A token that could not be read leaves its zones alone: they come back when it works again.
  if (w.problems.length) return;
  const gone = new Map<string, string[]>();
  for (const k of have) if (!want.has(k)) {
    const [check, kind, ...rest] = k.split(':');
    const id = rest.join(':');
    if (!(check in DEFS) || kind === 'global') continue;
    gone.set(`${check}:${kind}`, [...(gone.get(`${check}:${kind}`) ?? []), id]);
  }
  for (const [ck, ids] of gone) {
    const [check, kind] = ck.split(':') as [CheckId, ScopeKind];
    await forgetUnits(check, kind, ids);
  }
}

// ── Lanes ───────────────────────────────────────────────────────────────────

/** Tokens a backup or restore is using right now: monitoring leaves them alone. */
function busyLanes(w: World): Map<string, string> {
  const out = new Map<string, string>();
  const run = activeRunCredentialId();
  const restore = activeRestore();
  const lane = (id: string | null | undefined) => (id ? w.laneOfCredential.get(id) : undefined);
  const b = lane(run);
  if (b) out.set(b, 'A backup is using this token');
  const r = lane(restore?.credentialId);
  if (r) out.set(r, `A restore of ${restore!.zone} is using this token`);
  return out;
}

function laneLoad(lane: string) {
  let running = 0, reserved = 0;
  for (const r of q.running.values()) if (r.lane === lane) { running++; reserved += Math.max(0, r.est - r.calls.calls); }
  return { running, used: laneUse(lane).used + reserved };
}

/** The lane with the most room for a unit that takes about `est` calls, or null when none has room. */
function pickLane(candidates: string[], est: number, busy: Map<string, string>): string | null {
  let best: string | null = null, room = -1;
  for (const l of candidates) {
    if (busy.has(l) || laneUse(l).pausedUntil) continue;
    const load = laneLoad(l);
    const left = MONITOR_BUDGET - load.used;
    if (load.running >= PER_LANE || left < Math.min(est, MONITOR_BUDGET / 2)) continue;
    if (left > room) { best = l; room = left; }
  }
  return best;
}

// ── Running units ───────────────────────────────────────────────────────────

/** Hours until a unit runs again. */
function nextHours(def: CheckDef, kind: ScopeKind, cfg: MonitorConfig, r: UnitResult) {
  let h = kind === def.main ? cfg.intervals[def.id] : def.every?.[kind] ?? cfg.intervals[def.id];
  if (r.idle && def.idleHours) h = Math.max(h, def.idleHours);
  if (r.dueInHours) h = Math.min(h, r.dueInHours);
  return h;
}
/** ±5 %, so units started together drift apart instead of all coming due in the same minute. */
const jitter = (ms: number) => ms * (0.95 + Math.random() * 0.1);

async function runUnit(t: TargetRow, w: World, laneKey: string, est: number, cfg: MonitorConfig) {
  const key = unitKey(t);
  const calls: MonitorCalls = { calls: 0 };
  q.running.set(key, { lane: laneKey, est, calls });
  const k: UnitKey = { check: t.check_id, kind: t.scope_kind, id: t.scope_id };
  const def = DEFS[t.check_id];
  const started = Date.now();
  try {
    must(await db().from('monitor_targets').update({ lease_until: new Date(started + LEASE_MS).toISOString() }).eq('check_id', t.check_id).eq('scope_kind', t.scope_kind).eq('scope_id', t.scope_id), 'Taking a monitoring unit');
    const fn = def.units[t.scope_kind];
    if (!fn) throw new Error('This check has no such unit any more');
    const scope = t.scope_kind === 'zone' ? w.zones.get(t.scope_id) : t.scope_kind === 'account' ? w.accounts.get(t.scope_id) : null;
    const lane = w.lanes.get(laneKey);
    const target: UnitTarget = {
      kind: t.scope_kind, id: t.scope_id,
      accountId: scope?.accountId ?? t.account_id ?? '', accountName: scope?.accountName || t.account_name || '', zoneName: t.scope_kind === 'zone' ? scope?.name ?? t.zone_name ?? '' : '',
      token: lane?.token ?? '', credentialName: lane?.names.join(', ') ?? '',
      tokens: t.scope_kind === 'global' ? [...w.lanes.values()].map((l) => ({ token: l.token, credentialName: l.names.join(', ') })) : [],
    };
    const state = def.stateful?.includes(t.scope_kind) ? await readState(k) : null;
    const r = await asMonitor(calls, () => fn(target, { state }));
    await saveResult(k, { complete: r.complete, problems: r.problems ?? [], counts: r.counts ?? {}, state: r.state === undefined ? state : r.state, durationMs: Date.now() - started }, r.rows);
    const fresh = await syncFindings(k, r.findings, r.complete);
    if (fresh.length) q.unsent = true;
    const now = new Date();
    must(await db().from('monitor_targets').update({
      last_run_at: now.toISOString(), ...(r.complete ? { last_ok_at: now.toISOString() } : {}),
      last_error: r.complete ? null : (r.problems ?? []).join('; ').slice(0, 1000) || 'Read only in part',
      fail_count: 0, cost: calls.calls, priority: 0, lease_until: null,
      next_due_at: new Date(now.getTime() + jitter(nextHours(def, t.scope_kind, cfg, r) * HOUR)).toISOString(),
    }).eq('check_id', t.check_id).eq('scope_kind', t.scope_kind).eq('scope_id', t.scope_id), 'Saving the monitoring schedule');
    if (r.wake?.ids.length) {
      for (let i = 0; i < r.wake.ids.length; i += 200) {
        must(await db().from('monitor_targets').update({ next_due_at: now.toISOString(), priority: 1 }).eq('check_id', t.check_id).eq('scope_kind', r.wake.kind).in('scope_id', r.wake.ids.slice(i, i + 200)), 'Scheduling changed zones');
      }
    }
  } catch (err) {
    const waited = err instanceof BudgetError;
    const fails = waited ? t.fail_count : t.fail_count + 1;
    // Out of budget: soon again. Failing: 15 minutes, doubling up to the check's interval.
    const retry = waited ? 10 * 60_000 : Math.min(cfg.intervals[t.check_id] * HOUR, 15 * 60_000 * 2 ** Math.min(fails - 1, 8));
    if (!(err instanceof HttpError && err.status === 503)) console.error(`[monitoring] ${t.check_id} ${t.zone_name ?? t.account_name ?? t.scope_id}: ${message(err)}`);
    await db().from('monitor_targets').update({
      last_run_at: new Date().toISOString(), last_error: message(err).slice(0, 1000), fail_count: fails, cost: calls.calls || t.cost, lease_until: null,
      // A unit started by hand that failed goes back to the schedule; one that waited for the budget keeps its place.
      priority: waited ? t.priority : 0,
      next_due_at: new Date(Date.now() + retry).toISOString(),
    }).eq('check_id', t.check_id).eq('scope_kind', t.scope_kind).eq('scope_id', t.scope_id);
  } finally {
    q.running.delete(key);
    soon();
  }
}

/** Looks for due units: the main loop. */
async function tick() {
  if (q.ticking) return;
  q.ticking = true;
  try {
    const cfg = await getMonitorConfig();
    // The schedule runs on the worker; elsewhere (one process for everything) only what someone started.
    const scheduled = cfg.scheduled && consoleRole() === 'worker';
    const w = await world();
    const busy = busyLanes(w);
    const nowIso = new Date().toISOString();
    let sel = db().from('monitor_targets').select('*').lte('next_due_at', nowIso);
    if (!scheduled) sel = sel.gt('priority', 0);
    const rows = (must(await sel.order('priority', { ascending: false }).order('next_due_at', { ascending: true }).limit(500), 'Reading the monitoring queue') as TargetRow[])
      .filter((r) => !q.running.has(unitKey(r)) && (!r.lease_until || r.lease_until < nowIso));
    q.due = rows.length;
    q.note = !w.lanes.size ? 'No Cloudflare credential is stored, or none could be read' : null;
    for (const r of rows) {
      if (q.running.size >= MAX_RUNNING) break;
      const def = DEFS[r.check_id];
      if (!def || !def.units[r.scope_kind]) continue;
      const est = r.cost ?? FIRST_COST[r.check_id]?.[r.scope_kind] ?? 3;
      let lane: string | null;
      if (r.scope_kind === 'global') {
        // Reads with every token: waits while any of them is busy.
        if (busy.size || [...q.running.keys()].some((k) => k.endsWith(':global:*'))) continue;
        lane = '';
      } else {
        const scope = r.scope_kind === 'zone' ? w.zones.get(r.scope_id) : w.accounts.get(r.scope_id);
        if (!scope) {
          // Not in the newest list: no token reads it any more (it is removed at the next full listing).
          await db().from('monitor_targets').update({ last_error: 'No stored token reads this any more', next_due_at: new Date(Date.now() + HOUR).toISOString() })
            .eq('check_id', r.check_id).eq('scope_kind', r.scope_kind).eq('scope_id', r.scope_id);
          continue;
        }
        lane = pickLane(scope.lanes, est, busy);
        if (lane === null) continue;
      }
      void runUnit(r, w, lane, est, cfg);
    }
    // New findings: in one batch every few minutes, and as soon as everything due is done.
    const idle = !q.running.size && !q.due;
    if (q.unsent && (idle || Date.now() - q.lastSent >= NOTIFY_MS)) {
      q.unsent = false;
      q.lastSent = Date.now();
      await sendUnsent().catch((err) => { console.error('[monitoring] notification failed:', message(err)); });
    }
  } catch (err) {
    const why = message(err);
    if (q.note !== why) { q.note = why; log(`waiting: ${why}`); }
  } finally {
    q.ticking = false;
  }
}

/** Looks again in a moment (after a unit finished, or a run was asked for). */
function soon() {
  if (q.timer) return;
  q.timer = setTimeout(() => { q.timer = null; void tick(); }, 50);
  q.timer.unref?.();
}

/** Starts the queue on this server (the worker, or the one process that does everything). */
export function startQueue() {
  if (q.started || consoleRole() === 'web') return;
  q.started = true;
  // The first batch of findings waits for the queue to empty (or NOTIFY_MS), like every other.
  q.lastSent = Date.now();
  setLanePause((lane) => (q.world ? busyLanes(q.world).get(lane) ?? null : null));
  setInterval(() => { void tick(); }, TICK_MS).unref?.();
  soon();
}

/** Units running or due: keeps the worker from stopping halfway. */
export const queueBusy = () => q.running.size > 0 || q.due > 0;

// ── For the API ─────────────────────────────────────────────────────────────

/**
 * Runs the given checks now (all their units, or those of one account or zone), before scheduled
 * work. The accounts and zones are listed again first when that list is over 10 minutes old.
 */
export async function requestRun(f: { checks: CheckId[]; accountId?: string; zoneId?: string }): Promise<number> {
  startQueue();
  // Credentials added or changed since the last listing: list again first, so the run includes them.
  // Otherwise an old list is refreshed in the background, and new zones join at the next listing.
  if (!q.world || !q.world.lanes.size || (await credentialPrint()) !== q.world.print) await rediscover();
  else if (Date.now() - q.world.at > DISCOVER_ON_RUN_MS) void rediscover().catch((err) => log(`listing accounts and zones failed: ${message(err)}`));
  return markDue(f);
}

async function markDue(f: { checks: CheckId[]; accountId?: string; zoneId?: string }): Promise<number> {
  let upd = db().from('monitor_targets').update({ next_due_at: new Date().toISOString(), priority: 1 }).in('check_id', f.checks);
  if (f.zoneId) upd = upd.eq('scope_id', f.zoneId).eq('scope_kind', 'zone');
  else if (f.accountId) upd = upd.eq('account_id', f.accountId);
  const rows = must(await upd.select('check_id'), 'Starting the checks') as unknown[];
  soon();
  return rows.length;
}

/** The queue right now, for the Overview page. */
export async function queueView(): Promise<QueueView> {
  const cfg = await getMonitorConfig();
  const w = q.world;
  const busy = w ? busyLanes(w) : new Map<string, string>();
  const lanes: LaneView[] = w ? [...w.lanes.values()].map((l) => {
    const use = laneUse(l.key);
    const load = laneLoad(l.key);
    return {
      name: l.names.join(', '), used: use.used, budget: MONITOR_BUDGET, running: load.running, accounts: l.accounts, zones: l.zones,
      paused: busy.get(l.key) ?? (use.pausedUntil ? `Cloudflare’s rate limit was reached — waiting until ${new Date(use.pausedUntil).toISOString()}` : null),
    };
  }).sort((a, b) => a.name.localeCompare(b.name)) : [];
  // On a server without the queue (the web side), count what is due from the table.
  let due = q.due;
  if (!q.started) {
    const res = await db().from('monitor_targets').select('check_id', { count: 'exact', head: true }).lte('next_due_at', new Date().toISOString());
    must(res, 'Reading the monitoring queue');
    due = res.count ?? 0;
  }
  return {
    busy: q.running.size > 0 || due > 0, running: q.running.size, due, lanes,
    discoveredAt: w ? new Date(w.at).toISOString() : null, scheduled: cfg.scheduled, note: q.note ?? (w?.problems.length ? w.problems.slice(0, 3).join(' · ') : null),
  };
}

