// Runs the Backup Console worker on Cloudflare Containers.
//
// The container is the console's Docker image started with CONSOLE_ROLE=worker: it takes the
// backups, restores and Cloudflare / R2 / S3 calls the Vercel side queues in Supabase. It only
// connects out, so nothing here is reachable from the internet. This Worker keeps one instance
// running: it never lets it sleep, and a cron trigger starts it again every minute if Cloudflare
// stopped it (first deploy, host maintenance, a crash) or if its secrets changed.
//
// Bindings and secrets (env):
//   CONSOLE_WORKER                                            the container's Durable Object
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY Worker secrets
//   REDIS_URL                                                 optional: Redis for the shared cache
//
// GET /status shows whether the container runs and which settings are set (never their values).
import { Container, getContainer } from '@cloudflare/containers';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const RUNNING = ['running', 'healthy'];

/** A fingerprint of the settings a container starts with (to notice when the secrets change). */
async function fingerprint(vars) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(vars)));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ConsoleWorker extends Container {
  defaultPort = 4400;
  sleepAfter = '1h';

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = {
      CONSOLE_ROLE: 'worker',
      // The disk is fresh on every start: keep one id, and let the port check reach the server.
      CONSOLE_WORKER_ID: 'cloudflare-container',
      CONSOLE_LISTEN_HOST: '0.0.0.0',
    };
    for (const name of [...REQUIRED, 'REDIS_URL']) if (env[name]) this.envVars[name] = env[name];
  }

  // Backups and restores run with no request to the container, so it must not sleep when idle.
  async onActivityExpired() {
    this.renewActivityTimeout();
  }

  onStop(params) {
    console.log(`worker container stopped (exit ${params?.exitCode ?? '?'}, ${params?.reason ?? 'no reason given'}); the next cron run starts it again`);
  }

  /**
   * Called every minute: starts the container if it is not running, and restarts it when the
   * secrets changed since it started (a container keeps the settings it started with).
   */
  async ensureRunning() {
    const want = await fingerprint(this.envVars);
    const had = await this.ctx.storage.get('started-with');
    const { status } = await this.getState();
    if (RUNNING.includes(status) && had && had !== want) {
      console.log('worker settings changed: restarting the container with the new secrets');
      await this.destroy();
    }
    const missing = REQUIRED.filter((n) => !this.envVars[n]);
    if (missing.length) console.log(`worker secrets missing: ${missing.join(', ')} (Settings > Variables and Secrets); the worker cannot reach Supabase without them`);
    await this.startAndWaitForPorts();
    await this.ctx.storage.put('started-with', want);
  }

  /** Whether the container runs and which settings it has (names only). */
  async report() {
    const state = await this.getState();
    return {
      container: state.status,
      since: state.lastChange ? new Date(state.lastChange).toISOString() : null,
      settings: Object.fromEntries([...REQUIRED, 'REDIS_URL'].map((n) => [n, this.envVars[n] ? 'set' : 'missing'])),
    };
  }
}

const worker = (env) => getContainer(env.CONSOLE_WORKER, 'main');

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(worker(env).ensureRunning());
  },

  async fetch(request, env) {
    if (new URL(request.url).pathname === '/status') {
      try {
        return Response.json(await worker(env).report(), { headers: { 'cache-control': 'no-store' } });
      } catch (err) {
        return Response.json({ error: String(err?.message ?? err) }, { status: 500 });
      }
    }
    // Nothing else is served: the worker talks to Supabase, not to browsers.
    return new Response('Backup Console worker host. GET /status shows the container. The worker connects out to Supabase; see Settings › Worker in the console.\n', { status: 404 });
  },
};
