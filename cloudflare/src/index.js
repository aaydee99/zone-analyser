// Runs the Backup Console worker on Cloudflare Containers.
//
// The container is the console's Docker image started with CONSOLE_ROLE=worker: it takes the
// backups, restores and Cloudflare / R2 / S3 calls the Vercel side queues in Supabase. It only
// connects out, so nothing here is reachable from the internet. This Worker keeps one instance
// running: it never lets it sleep, and a cron trigger starts it again every minute if Cloudflare
// stopped it (first deploy, host maintenance, a crash).
//
// Bindings and secrets (env):
//   CONSOLE_WORKER                                            the container's Durable Object
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY Worker secrets
//   REDIS_URL                                                 optional: Redis for the shared cache
import { Container, getContainer } from '@cloudflare/containers';

export class ConsoleWorker extends Container {
  defaultPort = 4400;
  sleepAfter = '1h';

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = {
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      CONSOLE_ROLE: 'worker',
      // The disk is fresh on every start: keep one id, and let the port check reach the server.
      CONSOLE_WORKER_ID: 'cloudflare-container',
      CONSOLE_LISTEN_HOST: '0.0.0.0',
      ...(env.REDIS_URL ? { REDIS_URL: env.REDIS_URL } : {}),
    };
  }

  // Backups and restores run with no request to the container, so it must not sleep when idle.
  async onActivityExpired() {
    this.renewActivityTimeout();
  }

  onStop(params) {
    console.log(`worker container stopped (exit ${params?.exitCode ?? '?'}, ${params?.reason ?? 'no reason given'}); the next cron run starts it again`);
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(getContainer(env.CONSOLE_WORKER, 'main').startAndWaitForPorts());
  },

  // Nothing is served: the worker talks to Supabase, not to browsers.
  async fetch() {
    return new Response('Backup Console worker host: nothing to open here. The worker connects out to Supabase; see Settings › Worker in the console.\n', { status: 404 });
  },
};
