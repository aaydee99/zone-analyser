import 'server-only';

// Long reads (Cloudflare analytics) run in the background: a request waits at most `waitMs` and
// otherwise answers how far the read got, so no request runs into the Cloudflare, Vercel or
// worker-relay timeouts. Later requests for the same key join the read that is running; it keeps
// going when nobody waits, and its result usually lands in the cache for the next request. With
// `keepMs`, a finished read is kept that long for the polls that name it (by `job`), and only for
// them: any other request starts a new read. With `abandonMs`, a read nobody has asked about for
// that long is stopped (its `signal` aborts), so it no longer spends Cloudflare's query limit.

/** `note`: what the read is waiting for, if anything (e.g. a rate limit). `signal`: aborts when the read is abandoned. */
export interface Progress { done: number; total: number; note?: string; signal?: AbortSignal }
export interface Pending { pending: true; job: string; done: number; total: number; startedAt: string; note?: string }

interface Job extends Progress { id: string; p: Promise<unknown>; startedAt: string; finished?: boolean; askedAt: number; waiting: number }
const g = globalThis as unknown as { __bgJobs?: Map<string, Job> };
const jobs = (g.__bgJobs ??= new Map());

export async function inBackground<T>(key: string, build: (progress: Progress) => Promise<T>, waitMs: number,
  opts: { keepMs?: number; join?: string | null; abandonMs?: number } = {}): Promise<T | Pending> {
  let job = jobs.get(key);
  if (job?.finished && job.id !== opts.join) job = undefined;
  if (!job) {
    const stop = new AbortController();
    const progress: Progress = { done: 0, total: 0, signal: stop.signal };
    const id = crypto.randomUUID();
    const drop = () => { if (jobs.get(key)?.id === id) jobs.delete(key); };
    let watch: ReturnType<typeof setInterval> | undefined;
    const p = build(progress).finally(() => {
      clearInterval(watch);
      const mine = jobs.get(key);
      if (!opts.keepMs || mine?.id !== id || stop.signal.aborted) return drop();
      mine.finished = true;
      setTimeout(drop, opts.keepMs).unref?.();
    });
    p.catch(() => { /* answered to whoever waits; the next request starts again */ });
    job = Object.assign(progress, { id, p, startedAt: new Date().toISOString(), askedAt: Date.now(), waiting: 0 });
    jobs.set(key, job);
    if (opts.abandonMs) {
      const mine = job;
      watch = setInterval(() => {
        if (mine.waiting || Date.now() - mine.askedAt < opts.abandonMs!) return;
        clearInterval(watch);
        drop();
        stop.abort(new Error('Nobody waits for this read any more'));
      }, Math.min(opts.abandonMs, 10_000));
      watch.unref?.();
    }
  }
  const asked = job;
  asked.waiting++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const out = await Promise.race([job.p as Promise<T>, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); })]).finally(() => { clearTimeout(timer); asked.waiting--; asked.askedAt = Date.now(); });
  return out ?? { pending: true, job: job.id, done: job.done, total: job.total, startedAt: job.startedAt, ...(job.note ? { note: job.note } : {}) };
}
