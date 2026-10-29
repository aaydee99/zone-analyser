// Runs once when the server starts. On a worker (`npm run worker`, CONSOLE_ROLE=worker) it puts
// back the records kept in Supabase (a fresh disk loses nothing), then starts the loop that takes
// the jobs the web side (Vercel) queues in Supabase.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.CONSOLE_ROLE?.trim().toLowerCase() !== 'worker') return;
  const { restoreMirrored } = await import('./lib/state-mirror');
  const n = await restoreMirrored().catch((err) => { console.error('[worker] could not restore records:', err); return 0; });
  if (n) console.log(`[worker] restored ${n} record(s) from Supabase`);
  const { startWorkerLoop } = await import('./lib/worker-loop');
  startWorkerLoop();
}
