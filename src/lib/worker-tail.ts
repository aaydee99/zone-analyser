import 'server-only';
import crypto from 'node:crypto';
import os from 'node:os';
import { audit } from './audit';
import type { Me } from './auth';
import { BudgetError, cfCall, cfList, cfReason, ok, refused } from './cf-read';
import { accountTargets } from './cf-targets';
import { HttpError } from './http';
import { db } from './supabase';
import { openRelay, sealRelay } from './vault';
import { opsMust } from './ops-store';
import {
  FilterError, TAIL_KEEP, TAIL_MINUTES, TAIL_VIEWER_IDLE_MS, checkFilters, reduceEvent, tailMessage,
  type TailEntry, type TailFilters, type TailItem, type TailPoll, type TailSessionView, type TailState,
} from './worker-tail-types';

// Live Worker logs. Starting one creates a Cloudflare tail (POST …/workers/scripts/{name}/tails,
// "Workers Tail Read" — it changes nothing in the Worker) and opens its WebSocket on the server that
// runs the route: the worker on Vercel, where the web side relays /api through Supabase and cannot
// stream. The events, in a short form without request headers or client IPs, are written to
// worker_tail_events while the session runs; the page asks for new ones every few seconds while it
// is open and visible. A session ends when its user stops it, after TAIL_MINUTES, when the page has
// not asked for TAIL_VIEWER_IDLE_MS, or when Cloudflare closes it — then the tail is deleted at
// Cloudflare and every event row with it. The tail's URL and id never reach the browser or a log.

const SCRIPT = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;
/** Sessions at once: per user, and on the whole console. */
const PER_USER = 1;
const TOTAL = 5;
/** The holder writes events and a heartbeat this often; a holder silent for STALE_MS is gone. */
const TICK_MS = 2_000;
const STALE_MS = 30_000;
/** Events per second kept; more are counted as dropped (lower the sampling). */
const MAX_PER_SECOND = 50;
const MAX_BUFFER = 500;
const MAX_ITEM_BYTES = 16_384;
const OPEN_TIMEOUT_MS = 15_000;
const POLL_LIMIT = 200;

type Sealed = Awaited<ReturnType<typeof sealRelay>>;
interface SessionRow {
  id: string; user_id: string; account_id: string; script: string; owner: string; status: TailState; reason: string | null;
  filters: TailFilters; tail_sealed: Sealed | null; events: number; dropped: number; started_at: string; expires_at: string;
  viewer_seen_at: string; owner_seen_at: string; stopped_at: string | null;
}
const COLS = 'id, user_id, account_id, script, owner, status, reason, filters, tail_sealed, events, dropped, started_at, expires_at, viewer_seen_at, owner_seen_at, stopped_at';

interface Live {
  id: string; accountId: string; script: string; token: string; tailId: string; ws: WebSocket;
  buf: TailItem[]; seq: number; events: number; dropped: number; second: number; inSecond: number;
  tick: ReturnType<typeof setInterval>; busy: boolean; ending: boolean; expiresAt: number;
}
const gl = globalThis as unknown as { __tails?: Map<string, Live>; __tailOwner?: string; __tailSwept?: number };
const live = (gl.__tails ??= new Map<string, Live>());
/** This process, as the holder of its sessions. */
const OWNER = (gl.__tailOwner ??= `${os.hostname().slice(0, 60)}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`);

const aad = (id: string) => `worker-tail:${id}`;
const sessions = () => db().from('worker_tail_sessions');
const eventsTable = () => db().from('worker_tail_events');

const view = (r: SessionRow): TailSessionView => ({
  id: r.id, accountId: r.account_id, script: r.script, status: r.status, reason: r.reason, filters: r.filters,
  startedAt: r.started_at, expiresAt: r.expires_at, events: r.events, dropped: r.dropped,
});

async function accountToken(accountId: string) {
  const t = (await accountTargets()).accounts.find((x) => x.accountId === accountId);
  if (!t) throw new HttpError(404, 'No stored credential reads that account');
  return t;
}

const tailPath = (accountId: string, script: string, tailId?: string) => `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/tails${tailId ? `/${encodeURIComponent(tailId)}` : ''}`;

/** Cloudflare gives a wss:// URL; plain ws:// only to this machine (tests). */
function safeSocketUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  try {
    const url = new URL(u);
    if (url.protocol === 'wss:') return url.href;
    if (url.protocol === 'ws:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return url.href;
  } catch { /* not a URL */ }
  return null;
}

// ── Starting ────────────────────────────────────────────────────────────────

export async function startTail(me: Me, raw: { accountId?: unknown; script?: unknown; filters?: unknown }): Promise<TailSessionView> {
  const accountId = typeof raw.accountId === 'string' ? raw.accountId : '';
  const script = typeof raw.script === 'string' ? raw.script : '';
  if (!ACCOUNT.test(accountId)) throw new HttpError(400, 'Choose an account');
  if (!SCRIPT.test(script)) throw new HttpError(400, 'Choose a Worker');
  let filters: TailFilters;
  try { filters = checkFilters(raw.filters); } catch (err) { throw err instanceof FilterError ? new HttpError(400, err.message) : err; }
  if (typeof globalThis.WebSocket !== 'function') throw new HttpError(501, `Live Worker logs need Node.js 22 or newer where the console runs (this one is ${process.version})`);
  await sweep(true);

  const active = opsMust(await sessions().select('id, user_id').neq('status', 'stopped').limit(50), 'Reading log sessions') as { id: string; user_id: string }[];
  if (active.filter((s) => s.user_id === me.id).length >= PER_USER) throw new HttpError(409, 'You are already following a Worker’s logs — stop that session first');
  if (active.length >= TOTAL) throw new HttpError(429, `${TOTAL} log sessions are running in the console already — try again when one ends`);
  const target = await accountToken(accountId);

  const expiresAt = new Date(Date.now() + TAIL_MINUTES * 60_000).toISOString();
  const row = opsMust(await sessions().insert({ user_id: me.id, account_id: accountId, script, owner: OWNER, status: 'starting', filters, expires_at: expiresAt }).select(COLS).single(), 'Starting a log session') as SessionRow;
  const fail = async (reason: string) => { await sessions().update({ status: 'stopped', reason, stopped_at: new Date().toISOString() }).eq('id', row.id); };

  let r;
  try { r = await cfCall<{ id?: string; url?: string; expires_at?: string }>(target.token, 'POST', tailPath(accountId, script)); } catch (err) {
    await fail('Cloudflare’s rate limit for this token is spent');
    if (err instanceof BudgetError) throw new HttpError(429, 'This token’s share of Cloudflare’s rate limit is spent for now — try again in a minute');
    throw err;
  }
  if (!ok(r)) {
    const why = cfReason(r);
    await fail(`Cloudflare: ${why}`);
    if (refused(r)) throw new HttpError(403, `Cloudflare refused it: the stored token needs “Account › Workers Tail Read” (${why})`);
    if (r.status === 404) throw new HttpError(404, `Cloudflare has no Worker “${script}” in this account`);
    throw new HttpError(502, `Cloudflare: ${why}`);
  }
  const tailId = String(r.body!.result?.id ?? '');
  const url = safeSocketUrl(r.body!.result?.url);
  if (!tailId || !url) {
    await fail('Cloudflare answered without a log stream');
    throw new HttpError(502, 'Cloudflare answered without a log stream');
  }
  const sealed = await sealRelay(Buffer.from(tailId, 'utf8'), aad(row.id));
  opsMust(await sessions().update({ tail_sealed: sealed }).eq('id', row.id), 'Starting a log session');

  try {
    await connect(row.id, accountId, script, target.token, tailId, url, filters, Date.parse(expiresAt));
  } catch (err) {
    await deleteTail(target.token, accountId, script, tailId);
    await sessions().update({ status: 'stopped', reason: 'Could not connect to Cloudflare’s log stream', stopped_at: new Date().toISOString(), tail_sealed: null }).eq('id', row.id);
    throw new HttpError(502, `Could not connect to Cloudflare’s log stream${err instanceof Error && err.message ? ` (${err.message})` : ''}`);
  }
  const now = new Date().toISOString();
  const started = opsMust(await sessions().update({ status: 'running', owner_seen_at: now, viewer_seen_at: now }).eq('id', row.id).select(COLS).single(), 'Starting a log session') as SessionRow;
  await audit(me, 'worker_tail.started', `${target.accountName || accountId} › ${script}`, { sessionId: row.id, accountId, script, filters });
  return view(started);
}

/** Opens the WebSocket and resolves once Cloudflare accepted the filters. */
function connect(id: string, accountId: string, script: string, token: string, tailId: string, url: string, filters: TailFilters, expiresAt: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let opened = false;
    const ws = new WebSocket(url, 'trace-v1');
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => { if (!opened) { try { ws.close(); } catch { /* closed */ } reject(new Error('timed out')); } }, OPEN_TIMEOUT_MS);
    const s: Live = {
      id, accountId, script, token, tailId, ws, buf: [], seq: 0, events: 0, dropped: 0, second: 0, inSecond: 0,
      tick: undefined as unknown as ReturnType<typeof setInterval>, busy: false, ending: false, expiresAt,
    };
    ws.addEventListener('open', () => {
      opened = true;
      clearTimeout(timer);
      try { ws.send(JSON.stringify(tailMessage(filters))); } catch { /* closes below */ }
      live.set(id, s);
      s.tick = setInterval(() => void tick(s), TICK_MS);
      s.tick.unref?.();
      resolve();
    });
    ws.addEventListener('message', (m) => receive(s, m.data));
    ws.addEventListener('error', () => { if (!opened) { clearTimeout(timer); reject(new Error('refused')); } });
    ws.addEventListener('close', () => {
      if (!opened) { clearTimeout(timer); reject(new Error('closed')); return; }
      if (!s.ending) void finish(id, 'Cloudflare closed the log stream');
    });
  });
}

function receive(s: Live, data: unknown) {
  if (s.ending) return;
  let parsed: unknown;
  try { parsed = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer)); } catch { return; }
  for (const e of Array.isArray(parsed) ? parsed : [parsed]) {
    const item = reduceEvent(e);
    if (!item) continue;
    s.events++;
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== s.second) { s.second = sec; s.inSecond = 0; }
    if (++s.inSecond > MAX_PER_SECOND || s.buf.length >= MAX_BUFFER) { s.dropped++; continue; }
    if (JSON.stringify(item).length > MAX_ITEM_BYTES) { item.logs = item.logs.slice(0, 5).map((l) => ({ ...l, text: l.text.slice(0, 500) })); item.cut = true; }
    s.buf.push(item);
  }
}

/** The holder's beat: writes new events, then ends the session when it should end. */
async function tick(s: Live) {
  if (s.busy || s.ending) return;
  s.busy = true;
  try {
    const now = Date.now();
    // Only while still running (any worker may have ended it meanwhile).
    const res = await sessions().update({ owner_seen_at: new Date(now).toISOString(), events: s.events, dropped: s.dropped }).eq('id', s.id).in('status', ['starting', 'running']).select('viewer_seen_at');
    if (res.error) return;
    const row = (res.data ?? [])[0] as { viewer_seen_at: string } | undefined;
    if (!row) { await closeLocal(s); return; }
    if (now > s.expiresAt) { await finish(s.id, `Stopped after ${TAIL_MINUTES} minutes`); return; }
    if (now - Date.parse(row.viewer_seen_at) > TAIL_VIEWER_IDLE_MS) { await finish(s.id, 'Stopped: the page was closed or hidden'); return; }
    if (!s.buf.length) return;
    const items = s.buf.splice(0);
    const rows = items.map((data) => ({ session_id: s.id, seq: ++s.seq, at: data.at, data }));
    const ins = await eventsTable().insert(rows);
    if (ins.error) { s.dropped += rows.length; return; }
    if (s.seq > TAIL_KEEP) await eventsTable().delete().eq('session_id', s.id).lte('seq', s.seq - TAIL_KEEP);
  } catch { /* the next beat tries again */ } finally {
    s.busy = false;
  }
}

/** Closes this process's WebSocket of a session (it ended elsewhere, or here). */
async function closeLocal(s: Live) {
  s.ending = true;
  clearInterval(s.tick);
  s.buf.length = 0;
  live.delete(s.id);
  try { s.ws.close(1000); } catch { /* closed */ }
}

async function deleteTail(token: string, accountId: string, script: string, tailId: string) {
  try { await cfCall(token, 'DELETE', tailPath(accountId, script, tailId)); } catch { /* it expires at Cloudflare by itself */ }
}

/**
 * Ends a session from any process: the WebSocket here (if this process holds it), the tail at
 * Cloudflare, the events, then the row is marked stopped (kept a few minutes for the page).
 */
async function finish(id: string, reason: string) {
  const mine = live.get(id);
  if (mine) await closeLocal(mine);
  const row = (await sessions().select(COLS).eq('id', id).maybeSingle()).data as SessionRow | null;
  if (!row) return;
  if (row.status !== 'stopped') {
    // Taken first, so two processes ending it at once do not both delete the tail.
    const took = await sessions().update({ status: 'stopping' }).eq('id', id).in('status', ['starting', 'running']).select('id');
    if (took.data?.length || row.status === 'stopping') {
      try {
        const tailId = mine?.tailId ?? (row.tail_sealed ? (await openRelay(row.tail_sealed, aad(id))).toString('utf8') : '');
        const token = mine?.token ?? (await accountToken(row.account_id)).token;
        if (tailId) await deleteTail(token, row.account_id, row.script, tailId);
      } catch { /* the tail expires at Cloudflare by itself */ }
    }
  }
  await eventsTable().delete().eq('session_id', id);
  await sessions().update({ status: 'stopped', reason: row.status === 'stopped' ? row.reason : reason, stopped_at: row.stopped_at ?? new Date().toISOString(), tail_sealed: null, events: mine?.events ?? row.events, dropped: mine?.dropped ?? row.dropped }).eq('id', id);
}

/**
 * Housekeeping on each use (at most every 15 s per process): sessions whose holder went silent are
 * ended from here; stopped ones are deleted after a few minutes, and anything long past its end.
 */
async function sweep(force = false) {
  if (!force && (gl.__tailSwept ?? 0) > Date.now() - 15_000) return;
  gl.__tailSwept = Date.now();
  const stale = opsMust(await sessions().select('id').neq('status', 'stopped').lt('owner_seen_at', new Date(Date.now() - STALE_MS).toISOString()).limit(20), 'Reading log sessions') as { id: string }[];
  for (const s of stale) if (!live.has(s.id)) await finish(s.id, 'Stopped: the server holding the session went away');
  await sessions().delete().eq('status', 'stopped').lt('stopped_at', new Date(Date.now() - 10 * 60_000).toISOString());
  await sessions().delete().lt('expires_at', new Date(Date.now() - 60 * 60_000).toISOString());
}

// ── Following and stopping ──────────────────────────────────────────────────

async function own(me: Me, id: string): Promise<SessionRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'No such log session');
  const row = opsMust(await sessions().select(COLS).eq('id', id).eq('user_id', me.id).maybeSingle(), 'Reading the log session') as SessionRow | null;
  if (!row) throw new HttpError(404, 'This log session has ended');
  return row;
}

/** New events after `after`, and the session's state. Counts as the page still watching. */
export async function pollTail(me: Me, id: string, after: number): Promise<TailPoll> {
  let row = await own(me, id);
  if (row.status === 'running' || row.status === 'starting') {
    if (Date.now() - Date.parse(row.owner_seen_at) > STALE_MS && !live.has(id)) {
      await finish(id, 'Stopped: the server holding the session went away');
      row = await own(me, id);
    } else {
      await sessions().update({ viewer_seen_at: new Date().toISOString() }).eq('id', id);
    }
  }
  void sweep().catch(() => {});
  const rows = opsMust(await eventsTable().select('seq, data').eq('session_id', id).gt('seq', Math.max(0, after)).order('seq', { ascending: true }).limit(POLL_LIMIT), 'Reading log events') as { seq: number; data: TailItem }[];
  const items: TailEntry[] = rows.map((r) => ({ ...r.data, seq: r.seq }));
  return { session: view(row), items, next: items.length ? items[items.length - 1].seq : Math.max(0, after) };
}

/** The user's session that is still running, to pick up again after a reload. */
export async function currentTail(me: Me): Promise<TailSessionView | null> {
  const row = opsMust(await sessions().select(COLS).eq('user_id', me.id).neq('status', 'stopped').order('started_at', { ascending: false }).limit(1).maybeSingle(), 'Reading log sessions') as SessionRow | null;
  return row ? view(row) : null;
}

export async function stopTail(me: Me, id: string): Promise<TailSessionView> {
  const row = await own(me, id);
  if (row.status !== 'stopped') {
    await finish(id, 'Stopped by you');
    await audit(me, 'worker_tail.stopped', row.script, { sessionId: id, accountId: row.account_id, script: row.script, events: row.events });
  }
  return view(await own(me, id));
}

/** Stops every session this process holds (the worker is shutting down). */
export async function stopAllTails() {
  await Promise.all([...live.keys()].map((id) => finish(id, 'Stopped: the server restarted').catch(() => {})));
}

/** The Workers of an account: from monitoring's stored list (Developer platform), else read live. */
export async function accountScripts(accountId: string, fresh = false): Promise<{ scripts: { name: string; modified: string | null }[]; from: 'stored' | 'live'; at: string | null }> {
  if (!ACCOUNT.test(accountId)) throw new HttpError(400, 'Choose an account');
  if (!fresh) {
    const res = await db().from('monitor_rows').select('data').eq('check_id', 'platform').eq('section', 'workers').eq('scope_kind', 'account').eq('scope_id', accountId).order('sort').order('id').limit(1000);
    const at = await db().from('monitor_results').select('ran_at').eq('check_id', 'platform').eq('scope_kind', 'account').eq('scope_id', accountId).maybeSingle();
    if (!res.error && res.data?.length) {
      return { scripts: (res.data as { data: { name?: string; modified?: string | null } }[]).map((r) => ({ name: String(r.data.name ?? ''), modified: r.data.modified ?? null })).filter((s) => s.name), from: 'stored', at: (at.data as { ran_at?: string } | null)?.ran_at ?? null };
    }
  }
  const t = await accountToken(accountId);
  try {
    const list = await cfList<{ id: string; modified_on?: string }>(t.token, `/accounts/${accountId}/workers/scripts`, { perPage: 0, max: 1000 });
    return { scripts: list.map((s) => ({ name: s.id, modified: s.modified_on ?? null })).sort((a, b) => a.name.localeCompare(b.name)), from: 'live', at: new Date().toISOString() };
  } catch (err) {
    if (err instanceof BudgetError) throw new HttpError(429, 'This token’s share of Cloudflare’s rate limit is spent for now — try again in a minute');
    throw new HttpError(502, err instanceof Error ? err.message : 'Could not list the Workers');
  }
}
