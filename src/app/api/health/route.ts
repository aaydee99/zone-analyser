import { NextResponse } from 'next/server';
import { publicRoute } from '@/lib/http';
import { db, isConfigured } from '@/lib/supabase';
import { latestWorker } from '@/lib/worker-link';

export const dynamic = 'force-dynamic';

/**
 * For uptime monitors, without a session: 200 when the console can reach its database, 503 when
 * not. Says whether a worker is running (it starts on demand, so "no worker" is not a failure).
 * Answers nothing else: no versions, hosts, counts or errors' details.
 */
export const GET = publicRoute(async () => {
  const started = Date.now();
  let database = false;
  if (isConfigured()) {
    const { error } = await db().from('settings').select('id', { count: 'exact', head: true });
    database = !error;
  }
  const ms = Date.now() - started;
  const worker = database ? ((await latestWorker().catch(() => null))?.online ?? false) : false;
  return NextResponse.json({ ok: database, database: database ? 'ok' : 'unreachable', databaseMs: ms, worker: worker ? 'online' : 'offline' },
    { status: database ? 200 : 503 });
});
