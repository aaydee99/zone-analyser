import 'server-only';
import { NextResponse } from 'next/server';
import { inBackground, type Pending, type Progress } from './bg-job';

// The investigation reads run in the background (bg-job.ts): a request waits a while, then answers
// 202 with how far the read got and its `job`; the page asks again with &job=… until the result is
// there. A finished read is kept a minute for the polls that name it; one nobody asks about for
// 90 seconds is stopped, so it no longer spends Cloudflare's query limit.

const WAIT_MS = 20_000;
const POLL_WAIT_MS = 5_000;

export async function backgroundAnswer<T>(key: string, job: string | null, build: (progress: Progress) => Promise<T>): Promise<T | Response> {
  const out = await inBackground<T>(key, build, job ? POLL_WAIT_MS : WAIT_MS, { keepMs: 60_000, join: job, abandonMs: 90_000 });
  if (out && typeof out === 'object' && 'pending' in out) return NextResponse.json(out as Pending, { status: 202, headers: { 'Retry-After': '3' } });
  return out as T;
}
