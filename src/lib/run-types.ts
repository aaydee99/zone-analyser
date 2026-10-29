// Shared by server and client — no Node imports.
import type { BackupConfig } from './config';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface RunSummary {
  account?: string;
  backupRoot?: string;
  zonesTotal?: number;
  zonesDone?: number;
  apiErrors?: number;
  jsonMissing?: number;
  quarantined?: number;
  generateFailures?: number;
  gaps?: boolean;
  warnings: number;
  errors: number;
}

export interface RunMeta {
  id: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  presetName?: string;
  config: BackupConfig;
  /** Resolved OUTPUT_DIR; the backup folder must sit inside it to be browsable. */
  outputDir?: string;
  credentialNames: { cloudflare?: string; r2?: string; aws?: string };
  /** Email of the user who started the run. */
  startedBy?: string;
  /** Redacted, copy-pasteable equivalent of what was executed. */
  command: string;
  summary: RunSummary;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

/** Derives progress and integrity numbers from backup.js output. */
export function summarizeLines(lines: string[], into: RunSummary = { warnings: 0, errors: 0 }): RunSummary {
  const s = into;
  for (const raw of lines) {
    const line = stripAnsi(raw);
    if (line.startsWith('[WARN]')) s.warnings++;
    else if (line.startsWith('[ERROR]')) s.errors++;
    let m: RegExpExecArray | null;
    if ((m = /^\[INFO\]\s+Output\s+:\s+(.+)$/.exec(line))) s.backupRoot = m[1].trim();
    else if ((m = /^\[INFO\]\s+Account\s+:\s+(.+) \([0-9a-f]{32}\)$/.exec(line))) s.account = m[1];
    else if ((m = /^\[INFO\]\s+Zones\s+:\s+(\d+) zone/.exec(line))) s.zonesTotal = Number(m[1]);
    else if ((m = /━━━\s+\[Zone (\d+)\/(\d+)\]/.exec(line))) { s.zonesDone = Number(m[1]) - 1; s.zonesTotal = Number(m[2]); }
    else if ((m = /Failed API requests: (\d+) \| JSON not saved: (\d+) \| quarantined HCL files: (\d+) \| cf-terraforming failures: (\d+)/.exec(line))) {
      [s.apiErrors, s.jsonMissing, s.quarantined, s.generateFailures] = m.slice(1).map(Number);
    } else if (line.includes('No gaps detected')) s.gaps = false;
    else if (line.includes('Backup has gaps')) s.gaps = true;
    else if ((m = /Zones backed up: (\d+)/.exec(line))) s.zonesDone = Number(m[1]);
  }
  return s;
}
