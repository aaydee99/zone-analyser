import 'server-only';
import { db, must } from './supabase';
import { HttpError } from './http';

export interface Settings {
  /** Sign a user out after this many idle minutes (at most MAX_SESSION_IDLE_MINUTES). */
  sessionIdleMinutes: number;
  /** Lock the vault (super admin view) after this many idle minutes. */
  vaultAutoLockMinutes: number;
  /** Default OUTPUT_DIR when a run leaves it blank. */
  outputDir: string;
  /** TF_PLUGIN_CACHE_DIR; blank = <data>/plugin-cache. */
  pluginCacheDir: string;
}

/** Sessions never stay alive longer than this without activity, whatever is stored. */
export const MAX_SESSION_IDLE_MINUTES = 30;

export const DEFAULT_SETTINGS: Settings = {
  sessionIdleMinutes: MAX_SESSION_IDLE_MINUTES,
  vaultAutoLockMinutes: 10,
  outputDir: '',
  pluginCacheDir: '',
};

const CACHE_MS = 10_000;
const g = globalThis as unknown as { __cfSettings?: { value: Settings; at: number } };

function pick(raw: Partial<Settings> | null | undefined): Settings {
  const m = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  const idle = Number(m.sessionIdleMinutes);
  const sessionIdleMinutes = Number.isFinite(idle) && idle >= 1 ? Math.min(idle, MAX_SESSION_IDLE_MINUTES) : MAX_SESSION_IDLE_MINUTES;
  return { sessionIdleMinutes, vaultAutoLockMinutes: m.vaultAutoLockMinutes, outputDir: m.outputDir, pluginCacheDir: m.pluginCacheDir };
}

export async function getSettings(): Promise<Settings> {
  if (g.__cfSettings && Date.now() - g.__cfSettings.at < CACHE_MS) return g.__cfSettings.value;
  const row = must(await db().from('settings').select('data').eq('id', 1).maybeSingle(), 'Reading settings');
  const value = pick(row?.data as Partial<Settings> | undefined);
  g.__cfSettings = { value, at: Date.now() };
  return value;
}

/** Cached value for synchronous callers (idle timers); falls back to defaults before the first read. */
export const cachedSettings = (): Settings => g.__cfSettings?.value ?? DEFAULT_SETTINGS;

const minutes = (v: unknown, label: string, max: number) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1 || n > max) throw new HttpError(400, `${label} must be 1–${max} minutes`);
  return n;
};

export async function saveSettings(patch: Partial<Settings>, userId: string): Promise<Settings> {
  const next = { ...(await getSettings()) };
  if (patch.sessionIdleMinutes !== undefined) next.sessionIdleMinutes = minutes(patch.sessionIdleMinutes, 'Session timeout', MAX_SESSION_IDLE_MINUTES);
  if (patch.vaultAutoLockMinutes !== undefined) next.vaultAutoLockMinutes = minutes(patch.vaultAutoLockMinutes, 'Vault auto-lock', 24 * 60);
  for (const k of ['outputDir', 'pluginCacheDir'] as const) {
    if (patch[k] !== undefined) {
      const v = String(patch[k]).trim();
      if (/[\r\n]/.test(v)) throw new HttpError(400, `${k} must be a single line`);
      next[k] = v;
    }
  }
  must(await db().from('settings').upsert({ id: 1, data: next, updated_by: userId, updated_at: new Date().toISOString() }), 'Saving settings');
  g.__cfSettings = { value: next, at: Date.now() };
  return next;
}

