import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './supabase';
import { DATA_DIR } from './store';
import { consoleRole } from './worker-link';

// On a worker, records kept as files (approvals, restore history) are copied to Supabase
// (public.state_files) as they are saved, and written back on start: a worker whose disk is wiped
// on restart (Cloudflare Containers) loses nothing. Other roles keep files only.

const mirrors = () => consoleRole() === 'worker' && process.env.CONSOLE_STATE_MIRROR !== '0';
const g = globalThis as unknown as { __stateMirror?: Map<string, Promise<void>> };
const chains = (g.__stateMirror ??= new Map<string, Promise<void>>());

/** Copies one record to Supabase, after any earlier save of the same file (never throws). */
export function mirrorFile(rel: string, data: unknown) {
  if (!mirrors()) return;
  const next = (chains.get(rel) ?? Promise.resolve()).then(async () => {
    const { error } = await db().from('state_files').upsert({ path: rel, data, updated_at: new Date().toISOString() });
    if (error) console.error(`[state] could not copy ${rel} to Supabase: ${error.message}`);
  }).catch((err) => console.error(`[state] could not copy ${rel}:`, err));
  chains.set(rel, next);
  void next.finally(() => { if (chains.get(rel) === next) chains.delete(rel); });
}

/** Writes the records kept in Supabase back to the data folder (newer copies only). */
export async function restoreMirrored(): Promise<number> {
  if (!mirrors()) return 0;
  let restored = 0;
  const PAGE = 500;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db().from('state_files').select('path, data, updated_at').order('path').range(from, from + PAGE - 1);
    if (error) {
      console.error(`[state] could not read the records from Supabase: ${error.message}`);
      return restored;
    }
    for (const row of (data ?? []) as { path: string; data: unknown; updated_at: string }[]) {
      if (!/^[a-z-]+\/[A-Za-z0-9_-]{1,64}\.json$/.test(row.path)) continue;
      const file = path.join(DATA_DIR, ...row.path.split('/'));
      try {
        if (fs.existsSync(file) && fs.statSync(file).mtimeMs >= Date.parse(row.updated_at)) continue;
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, JSON.stringify(row.data), { mode: 0o600 });
        restored++;
      } catch (err) {
        console.error(`[state] could not write ${row.path}:`, err instanceof Error ? err.message : err);
      }
    }
    if ((data ?? []).length < PAGE) break;
  }
  return restored;
}
