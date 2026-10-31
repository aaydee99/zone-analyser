#!/usr/bin/env node
// npm run worker — runs this console as the worker for a Vercel deployment.
//
// Installs the dependencies and builds the app when needed, then starts it with CONSOLE_ROLE=worker
// on 127.0.0.1 (it needs no inbound access: it only connects out to Supabase, Cloudflare, R2 / S3).
// On start it downloads Terraform and cf-terraforming (checksum-verified) if they are missing, and
// takes the backups, restores and Cloudflare reads the Vercel side queues in Supabase.
// It restarts the server if it stops. Settings come from .env.local (or the environment):
// SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY — the same values as on Vercel.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || '4400';
// 127.0.0.1 normally; a container platform that checks the port from outside (Cloudflare) sets 0.0.0.0.
const HOST = process.env.CONSOLE_LISTEN_HOST || '127.0.0.1';
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const log = (m) => console.log(`[worker] ${m}`);

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 9)) {
  console.error(`[worker] Node.js 20.9 or newer is needed (this is ${process.versions.node}). Install it from https://nodejs.org or use the Docker image (see the README, Worker).`);
  process.exit(1);
}

const run = (args, what) => {
  log(`${what}…`);
  const r = spawnSync(NPM, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error(`[worker] ${what} failed`); process.exit(r.status ?? 1); }
};

/** Newest modification time under a folder (to see whether the build is older than the source). */
const newest = (dir) => {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return t;
};

if (!fs.existsSync(path.join(ROOT, 'node_modules', 'next'))) run(['ci', '--no-audit', '--no-fund'], 'Installing dependencies');
const buildId = path.join(ROOT, '.next', 'BUILD_ID');
const stale = !fs.existsSync(buildId) || process.argv.includes('--build')
  || Math.max(newest(path.join(ROOT, 'src')), fs.statSync(path.join(ROOT, 'package.json')).mtimeMs) > fs.statSync(buildId).mtimeMs;
if (stale) run(['run', 'build'], 'Building the console');

const env = {
  ...process.env, CONSOLE_ROLE: 'worker', PORT,
  // The worker's time limits count from its first start (worker.yml sets it at the start of the run), not from a restart.
  CONSOLE_WORKER_JOB_STARTED_AT: process.env.CONSOLE_WORKER_JOB_STARTED_AT || String(Date.now()),
  // SIGTERM / SIGINT are handled by the worker loop (src/lib/worker-loop.ts): it hands back its queued
  // calls and waits for its database writes before it exits, instead of Next.js exiting at once.
  NEXT_MANUAL_SIG_HANDLE: 'true',
};
let restarts = 0;
const start = () => {
  log(`starting on http://${HOST}:${PORT} (worker role)`);
  const startedAt = Date.now();
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-H', HOST, '-p', PORT], { cwd: ROOT, env, stdio: 'inherit' });
  // Asked to stop: the worker gets SIGTERM, hands back its calls, waits for its writes and exits; then so does this.
  let stopping = false;
  const stop = () => { stopping = true; child.kill('SIGTERM'); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  child.on('exit', (code, signal) => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (stopping || signal === 'SIGTERM' || signal === 'SIGINT') process.exit(0);
    // Exit code 0: the worker stopped itself (idle, or its time limit on GitHub Actions).
    if (code === 0) { log('stopped by itself'); process.exit(0); }
    // Ran for a while: start again at once; crashing on start: back off up to a minute.
    restarts = Date.now() - startedAt > 60_000 ? 0 : restarts + 1;
    const wait = Math.min(60_000, 1_000 * 2 ** restarts);
    log(`stopped (${code ?? signal}); starting again in ${Math.round(wait / 1000)} s`);
    setTimeout(start, wait);
  });
};
start();
