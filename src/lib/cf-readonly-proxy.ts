import 'server-only';
import http from 'node:http';
import crypto from 'node:crypto';

// Read-only guard for Terraform plans. Terraform (and cf-terraforming) reach the Cloudflare
// API through CLOUDFLARE_BASE_URL; during compare / plan / the post-apply check that URL points
// here. Reads go through to Cloudflare. Writes never leave this process: provider 5.28.1 sends
// PUT /rulesets/<id> during `terraform plan` when a ruleset is imported, which would change the
// live zone before anyone approved an apply. A write is answered with the object's current live
// state (a GET of the same URL), so the plan still shows the real difference.
// Only the apply runs without this guard.

const UPSTREAM = (process.env.CLOUDFLARE_BASE_URL || 'https://api.cloudflare.com/client/v4/').replace(/\/?$/, '/');
const PASS_HEADERS = ['authorization', 'x-auth-email', 'x-auth-key', 'accept', 'user-agent'];

export interface ReadOnlyProxy {
  /** Use as CLOUDFLARE_BASE_URL. */
  baseUrl: string;
  /** Writes that were refused ("PUT /zones/…/rulesets/…"). */
  blocked: string[];
  close: () => Promise<void>;
}

export async function startReadOnlyProxy(): Promise<ReadOnlyProxy> {
  const secret = crypto.randomBytes(12).toString('hex');
  const prefix = `/${secret}/client/v4/`;
  const blocked: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    void (async () => {
      const send = (status: number, body: string, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(body); };
      if (!req.url?.startsWith(prefix)) return send(404, JSON.stringify({ success: false, errors: [{ code: 7003, message: 'Not found' }], result: null }));
      const target = UPSTREAM + req.url.slice(prefix.length);
      const headers: Record<string, string> = {};
      for (const h of PASS_HEADERS) { const v = req.headers[h]; if (typeof v === 'string') headers[h] = v; }
      const method = (req.method ?? 'GET').toUpperCase();
      const read = method === 'GET' || method === 'HEAD';
      if (!read) blocked.push(`${method} ${new URL(target).pathname.replace(/^\/client\/v4/, '')}`);
      try {
        // A write is answered with what is live now, so Terraform plans against the real state.
        const r = await fetch(target, { method: read ? method : 'GET', headers, signal: AbortSignal.timeout(60_000), redirect: 'manual', cache: 'no-store' });
        const body = method === 'HEAD' ? '' : await r.text();
        if (!read && !r.ok) {
          return send(403, JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Blocked: restore plans are read-only (the console never sends writes while planning)' }], result: null }));
        }
        send(r.status, body, r.headers.get('content-type') ?? 'application/json');
      } catch (err) {
        console.error('[cf-readonly-proxy] upstream request failed:', err instanceof Error ? err.message : err);
        send(502, JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Could not reach the Cloudflare API' }], result: null }));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}${prefix}`,
    blocked,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
