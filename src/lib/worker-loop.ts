import 'server-only';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './supabase';
import { DATA_DIR, ensureDir } from './store';
import { ensureTools, toolStatus } from './tools';
import { openRelay, sealRelay } from './vault';
import { RELAY_CHUNK, RELAY_HEADER, type RelayRequest, type RelayResponse } from './worker-link';

// The worker: started inside `npm run worker` (src/instrumentation.ts). It announces itself in
// public.workers, keeps Terraform and cf-terraforming installed, and takes the calls the web side
// (Vercel) queues in public.worker_calls: each is replayed on this server over loopback, with the
// caller's identity signed, so it runs exactly as if it had been sent here, from this machine's IP.

const HEARTBEAT_MS = 5_000;
const IP_REFRESH_MS = 10 * 60_000;
const MAX_PARALLEL = 8;
const ANSWER_HEADERS = ['content-type', 'content-disposition', 'retry-after', 'cache-control'];

const g = globalThis as unknown as { __workerLoop?: boolean };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = () => Number(process.env.PORT) || 4400;
const base = () => `http://127.0.0.1:${port()}`;
const log = (msg: string) => console.log(`[worker] ${msg}`);

/** A stable id for this machine and folder (kept in the data folder). */
function workerId(): string {
  const file = path.join(DATA_DIR, 'worker-id');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* first start */ }
  ensureDir(DATA_DIR);
  const id = `${os.hostname()}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(file, id, { mode: 0o600 });
  return id;
}

/** This machine's public IP, as Cloudflare sees it (the IP to allow on IP-restricted tokens). */
async function publicIp(): Promise<string | null> {
  try {
    const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(5_000), cache: 'no-store' });
    return /^ip=(.+)$/m.exec(await res.text())?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export function startWorkerLoop() {
  if (g.__workerLoop) return;
  g.__workerLoop = true;
  void run().catch((err) => { g.__workerLoop = false; console.error('[worker] stopped:', err); });
}

async function run() {
  const id = workerId();
  const startedAt = new Date().toISOString();
  let ip: string | null = null;
  let ipAt = 0;
  let tools: { name: string; version: string | null }[] = [];
  const version = (() => { try { return (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: string }).version ?? null; } catch { return null; } })();

  const beat = async () => {
    if (Date.now() - ipAt > IP_REFRESH_MS) { ip = (await publicIp()) ?? ip; ipAt = Date.now(); }
    const { error } = await db().from('workers').upsert({
      id, hostname: os.hostname(), public_ip: ip, version, platform: `${process.platform} ${os.release()}`, tools, started_at: startedAt, last_seen: new Date().toISOString(),
    });
    if (error) log(`heartbeat failed: ${error.message}`);
  };

  // Wait for this server to answer before replaying calls on it.
  for (let i = 0; i < 120; i++) {
    try { await fetch(`${base()}/login`, { signal: AbortSignal.timeout(2_000) }); break; } catch { await sleep(500); }
  }
  await beat();
  log(`${id} online at ${base()}${ip ? `, public IP ${ip}` : ''}`);
  setInterval(() => { void beat().catch(() => {}); }, HEARTBEAT_MS);
  setInterval(() => { void purge().catch(() => {}); }, 60_000);

  // Terraform and cf-terraforming: downloaded (checksum-verified) when missing.
  void (async () => {
    try {
      await ensureTools((line) => log(line));
    } catch (err) {
      log(`tools: ${err instanceof Error ? err.message : String(err)}`);
    }
    tools = (await toolStatus().catch(() => [])).map((t) => ({ name: t.name, version: t.version ?? null }));
    await beat().catch(() => {});
  })();

  let inflight = 0;
  let lastWork = Date.now();
  for (;;) {
    let took = 0;
    if (inflight < MAX_PARALLEL) {
      const { data, error } = await db().from('worker_calls').select('id').eq('status', 'queued').gt('expires_at', new Date().toISOString())
        .order('created_at').limit(MAX_PARALLEL - inflight);
      if (error) { log(`queue: ${error.message}`); await sleep(2_000); continue; }
      for (const { id: callId } of (data ?? []) as { id: string }[]) {
        // Claimed only if still queued: a second worker never takes the same call.
        const claim = await db().from('worker_calls').update({ status: 'running', worker_id: id, claimed_at: new Date().toISOString() })
          .eq('id', callId).eq('status', 'queued').select('id, request');
        const row = (claim.data as { id: string; request: never }[] | null)?.[0];
        if (!row) continue;
        took++;
        inflight++;
        void handle(row.id, row.request).finally(() => { inflight--; });
      }
    }
    if (took || inflight) lastWork = Date.now();
    // Quick to pick up while busy, gentler on Supabase when idle.
    await sleep(took ? 50 : Date.now() - lastWork < 30_000 ? 250 : 1_000);
  }
}

const aadFor = (id: string, part = 'request') => `worker-call:${id}:${part}`;

async function handle(callId: string, sealed: never) {
  try {
    const r = JSON.parse((await openRelay(sealed, aadFor(callId))).toString('utf8')) as RelayRequest;
    const res = await fetch(`${base()}${r.path}`, {
      method: r.method,
      headers: { ...r.headers, [RELAY_HEADER]: r.identity, ...(r.method !== 'GET' && r.method !== 'HEAD' ? { origin: base() } : {}) },
      body: r.body ? new Uint8Array(Buffer.from(r.body, 'base64')) : undefined,
      redirect: 'manual',
      cache: 'no-store',
    });
    const headers: Record<string, string> = {};
    for (const h of ANSWER_HEADERS) { const v = res.headers.get(h); if (v) headers[h] = v; }
    const body = Buffer.from(await res.arrayBuffer());
    const answer: RelayResponse = { status: res.status, headers };
    let chunks = 0;
    if (body.length <= RELAY_CHUNK) {
      if (body.length) answer.body = body.toString('base64');
    } else {
      for (let off = 0; off < body.length; off += RELAY_CHUNK, chunks++) {
        const part = await sealRelay(body.subarray(off, off + RELAY_CHUNK), aadFor(callId, `chunk:${chunks}`));
        const ins = await db().from('worker_call_chunks').insert({ call_id: callId, seq: chunks, data: part });
        if (ins.error) throw new Error(`saving the answer: ${ins.error.message}`);
      }
    }
    const response = await sealRelay(Buffer.from(JSON.stringify(answer)), aadFor(callId, 'response'));
    await db().from('worker_calls').update({ status: 'done', response, chunks, done_at: new Date().toISOString() }).eq('id', callId);
  } catch (err) {
    await db().from('worker_calls').update({ status: 'failed', error: err instanceof Error ? err.message : String(err), done_at: new Date().toISOString() }).eq('id', callId);
  }
}

/** Calls nobody collected (the web side gave up): deleted a few minutes after they expired. */
async function purge() {
  await db().from('worker_calls').delete().lt('expires_at', new Date(Date.now() - 5 * 60_000).toISOString());
}
