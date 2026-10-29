'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Permission, Role } from '@/lib/rbac';
import type { ActiveRestore } from '@/lib/job-lock';
import type { WorkerSummary } from '@/lib/live-state';

export interface MeUser { id: string; email: string; name: string; role: Role }

export interface MeState {
  user: MeUser;
  permissions: Permission[];
  expiresAt: number | null;
  activeRunId: string | null;
  /** The restore job running now (compare, plan or apply), if any. Only one job runs at a time. */
  activeRestore: ActiveRestore | null;
  /** Requests waiting for this person to approve or reject. */
  pendingApprovals?: number;
  /** On Vercel: the worker that runs backups, restores and Cloudflare reads. */
  worker?: WorkerSummary;
}

interface Ctx extends MeState {
  can: (p: Permission) => boolean;
  refresh: () => void;
}

const MeContext = createContext<Ctx | null>(null);

export function MeProvider({ value, refresh, children }: { value: MeState; refresh: () => void; children: ReactNode }) {
  // Stable identity so pages can list `can` / the context in effect dependencies.
  const ctx = useMemo<Ctx>(() => {
    const set = new Set(value.permissions);
    return { ...value, can: (p) => set.has(p), refresh };
  }, [value, refresh]);
  return <MeContext.Provider value={ctx}>{children}</MeContext.Provider>;
}

/** The signed-in user. Hides UI only — the server enforces every permission itself. */
export function useMe(): Ctx {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error('useMe must be used inside the console shell');
  return ctx;
}
