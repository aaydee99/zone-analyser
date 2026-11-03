import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Handlers marked `on: 'web'` run on Vercel as well as on the worker (route() in src/lib/http.ts).
// There is no disk that lasts, no child process, no vault unlock and none of the worker's memory, so
// such a route file must not reach (through its imports, static or dynamic) the modules that need
// them. Type-only imports don't count: they are gone at run time.

const SRC = path.resolve('src');
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');

/** Modules that only work on the worker, and why. */
const WORKER_ONLY: Record<string, string> = {
  'lib/runner.ts': 'backup runs: child processes and run folders',
  'lib/restore.ts': 'restores: Terraform and run folders',
  'lib/restore-history.ts': 'restore history files',
  'lib/tools.ts': 'installs Terraform and cf-terraforming',
  'lib/worker-tail.ts': 'live Worker log sessions held open',
  'lib/worker-loop.ts': 'the worker loop',
  'lib/approvals-store.ts': 'approval files on the worker disk',
  'lib/backup-files.ts': 'backup files on disk',
  'lib/backup-sources.ts': 'backup folders and buckets',
  'lib/state-mirror.ts': 'copies worker files to Supabase',
  'lib/monitor-queue.ts': 'the monitoring queue in memory',
  'lib/cf-audit.ts': 'reads backups from disk',
  'lib/zone-audit/run.ts': 'audit slots in memory',
};
/** A route file whose other handlers stay on the worker may import what only those use. */
const ALLOWED: Record<string, string[]> = {
  // POST (start an audit) stays on the worker; only the GET (stored audits) runs on the web side.
  'app/api/security-audit/route.ts': ['lib/zone-audit/run.ts'],
};

/**
 * Imports of a worker-only module by a shared module, where only worker code calls what needs it
 * (checked by hand; the module has no effect when loaded). The walk doesn't follow these.
 */
const SHARED_EDGES: Record<string, string> = {
  // indexBackupZone / rebuild read backup folders (search/index, backups); searching only reads Supabase.
  'lib/zone-search.ts → lib/backup-sources.ts': 'indexing backups (worker)',
  // compareBackups / backup diffs (compare/backups, compare/backup-diff); templates only use Supabase.
  'lib/compare.ts → lib/backup-sources.ts': 'backup comparisons (worker)',
  // Purge, rollback and Logpush requests (worker routes); the timeline only reads Worker versions and Pages deployments (GET).
  'lib/cf-actions.ts → lib/approvals-store.ts': 'change requests (worker)',
  'lib/cf-actions.ts → lib/monitor-queue.ts': 'a Logpush change re-checks monitoring (worker)',
  // The audit-log read fills a deleted object's old value from Resource History, else from a local
  // backup folder: on the web side there is none (it finds nothing and carries on).
  'lib/cf-audit-cache.ts → lib/cf-audit.ts': 'local backup fallback for deleted values (none on the web side)',
};

const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+'([^']+)'|import\('([^']+)'\)/g;

function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? path.join(SRC, spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return spec.startsWith('node:') ? spec : null;
  for (const ext of ['', '.ts', '.tsx', '/index.ts']) if (existsSync(base + ext) && statSync(base + ext).isFile()) return base + ext;
  return null;
}

/** Every module the file reaches, with the module that imported it (for the failure message). */
function reach(file: string): Map<string, string | null> {
  const seen = new Map<string, string | null>();
  const queue: [string, string | null][] = [[file, null]];
  while (queue.length) {
    const [f, via] = queue.shift()!;
    if (seen.has(f)) continue;
    seen.set(f, via);
    if (f.startsWith('node:')) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) {
      const r = resolve(f, m[1] ?? m[2]);
      if (r && !SHARED_EDGES[`${rel(f)} → ${r.startsWith('node:') ? r : rel(r)}`]) queue.push([r, f]);
    }
  }
  return seen;
}
const chain = (seen: Map<string, string | null>, f: string) => {
  const out: string[] = [];
  for (let k: string | null = f; k; k = seen.get(k) ?? null) out.unshift(k.startsWith('node:') ? k : rel(k));
  return out.join(' → ');
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? routeFiles(p) : e.name === 'route.ts' ? [p] : [];
  });
}
const webFiles = routeFiles(path.join(SRC, 'app', 'api')).filter((f) => /\bon: 'web'/.test(readFileSync(f, 'utf8')));

test('routes that run on the web side reach no worker-only module', () => {
  assert.ok(webFiles.length >= 22, `found ${webFiles.length} route files marked on: 'web'`);
  const problems: string[] = [];
  for (const f of webFiles) {
    const seen = reach(f);
    const allowed = ALLOWED[rel(f)] ?? [];
    for (const m of seen.keys()) {
      const name = m.startsWith('node:') ? m : rel(m);
      if (name === 'node:child_process') problems.push(`${chain(seen, m)} (starts processes)`);
      else if (WORKER_ONLY[name] && !allowed.includes(name)) problems.push(`${chain(seen, m)} (${WORKER_ONLY[name]})`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the walk finds worker-only modules where they are used', () => {
  const names = (f: string) => [...reach(path.join(SRC, f)).keys()].map((m) => (m.startsWith('node:') ? m : rel(m)));
  assert.ok(names('app/api/runs/route.ts').includes('lib/runner.ts'));
  assert.ok(names('app/api/restore/route.ts').includes('node:child_process'));
  assert.ok(names('app/api/compare/backups/route.ts').includes('lib/compare.ts'));
});

test("only GET handlers are marked on: 'web' in files with an allowance", () => {
  for (const name of Object.keys(ALLOWED)) {
    const s = readFileSync(path.join(SRC, name), 'utf8');
    const handlers = [...s.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = route[\s\S]*?\n\}, (\{[^\n]*\})\);/g)];
    assert.ok(handlers.length > 0, name);
    for (const [, method, opts] of handlers) assert.equal(/on: 'web'/.test(opts), method === 'GET', `${name} ${method}`);
  }
});
