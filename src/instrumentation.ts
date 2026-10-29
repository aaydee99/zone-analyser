// Runs once when the server starts. On a worker (`npm run worker`, CONSOLE_ROLE=worker) it
// starts the loop that takes the jobs the web side (Vercel) queues in Supabase.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.CONSOLE_ROLE?.trim().toLowerCase() !== 'worker') return;
  const { startWorkerLoop } = await import('./lib/worker-loop');
  startWorkerLoop();
}
