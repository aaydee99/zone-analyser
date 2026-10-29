// The restore job running right now (compare, plan or apply), shared with the backup runner so
// only one job — a backup or a restore — runs at a time. Kept on globalThis like the stores.

export interface ActiveRestore {
  id: string;
  zone: string;
  /** What it is doing: comparing, planning or applying. */
  job: 'comparing' | 'planning' | 'applying';
  by: string;
  since: string;
}

const g = globalThis as unknown as { __restoreJob?: { current: ActiveRestore | null } };
const slot = (g.__restoreJob ??= { current: null });

export const activeRestore = (): ActiveRestore | null => slot.current;

export function setActiveRestore(r: ActiveRestore | null) {
  slot.current = r;
}
