import 'server-only';

// Long reads (Cloudflare analytics) run in the background: a request waits at most `waitMs` and
// otherwise answers how far the read got, so no request runs into the Cloudflare, Vercel or
// worker-relay timeouts. Later requests for the same key join the read that is running; it keeps
// going when nobody waits, and its result usually lands in the cache for the next request.

/** `note`: what the read is waiting for, if anything (e.g. a rate limit). */
export interface Progress { done: number; total: number; note?: string }
export interface Pending { pending: true; done: number; total: number; startedAt: string; note?: string }

interface Job extends Progress { p: Promise<unknown>; startedAt: string }
const g = globalThis as unknown as { __bgJobs?: Map<string, Job> };
const jobs = (g.__bgJobs ??= new Map());

export async function inBackground<T>(key: string, build: (progress: Progress) => Promise<T>, waitMs: number): Promise<T | Pending> {
  let job = jobs.get(key);
  if (!job) {
    const progress: Progress = { done: 0, total: 0 };
    const p = build(progress).finally(() => jobs.delete(key));
    p.catch(() => { /* answered to whoever waits; the next request starts again */ });
    job = Object.assign(progress, { p, startedAt: new Date().toISOString() });
    jobs.set(key, job);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const out = await Promise.race([job.p as Promise<T>, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); })]).finally(() => clearTimeout(timer));
  return out ?? { pending: true, done: job.done, total: job.total, startedAt: job.startedAt, ...(job.note ? { note: job.note } : {}) };
}
