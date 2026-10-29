import { HttpError, route } from '@/lib/http';
import { getRun, readRunLog, storedRun, storedRunLog, subscribe } from '@/lib/runner';
import { sessionStillValid } from '@/lib/auth';
import { isWebRole } from '@/lib/worker-link';
import type { Me } from '@/lib/auth';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' };

/** Server-sent events: the log so far, then live lines, then a final status event. */
export const GET = route<Ctx>(async (req, { params }, me) => {
  const id = (await params).id;
  if (isWebRole()) return followStored(req, id, me);
  if (!(await getRun(id))) throw new HttpError(404, 'Run not found');
  const backlog = await readRunLog(id);
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
      };
      const close = () => { cleanup(); try { controller.close(); } catch { /* closed */ } };
      send('backlog', backlog);
      const unsub = subscribe(id, (e) => {
        if (e.type === 'line') send('line', e.line);
        else { send('status', e.meta); close(); }
      });
      if (!unsub) { send('status', await getRun(id)); close(); return; }
      // Ends the stream if the viewer's session expires or is revoked.
      const ping = setInterval(() => (sessionStillValid(me.sessionHash) ? send('ping', Date.now()) : close()), 15_000);
      cleanup = () => { unsub(); clearInterval(ping); };
      req.signal.addEventListener('abort', close);
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}, { perm: 'runs:read' });

/** Max time one stream stays open on Vercel; the page reconnects and continues from the backlog. */
const WEB_STREAM_MS = 240_000;

/**
 * Web role (Vercel): the run is on the worker, which writes its log to Supabase as it goes.
 * The same events are sent by following run_logs and the run's status there.
 */
async function followStored(req: Request, id: string, me: Me) {
  const first = await storedRun(id);
  if (!first) throw new HttpError(404, 'Run not found');
  const enc = new TextEncoder();
  let stop = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { stop = true; }
      };
      req.signal.addEventListener('abort', () => { stop = true; });
      const until = Date.now() + WEB_STREAM_MS;
      let { lines, next } = await storedRunLog(id, 0);
      const backlog = [...lines];
      while (lines.length === 1000) { ({ lines, next } = await storedRunLog(id, next)); backlog.push(...lines); }
      send('backlog', backlog);
      let lastPing = Date.now();
      for (let meta = first; !stop; ) {
        if (meta.status !== 'running') {
          // The last lines may land just after the status: read once more, then finish.
          ({ lines, next } = await storedRunLog(id, next));
          for (const l of lines) send('line', l);
          send('status', meta);
          break;
        }
        if (Date.now() > until || !sessionStillValid(me.sessionHash)) break;
        await new Promise((r) => setTimeout(r, 1_000));
        ({ lines, next } = await storedRunLog(id, next));
        for (const l of lines) send('line', l);
        if (Date.now() - lastPing > 15_000) { send('ping', Date.now()); lastPing = Date.now(); }
        meta = (await storedRun(id)) ?? meta;
      }
      try { controller.close(); } catch { /* closed */ }
    },
    cancel() { stop = true; },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
