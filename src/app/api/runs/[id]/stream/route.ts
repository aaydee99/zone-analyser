import { HttpError, route } from '@/lib/http';
import { getRun, readRunLog, subscribe } from '@/lib/runner';
import { sessionStillValid } from '@/lib/auth';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Server-sent events: the log so far, then live lines, then a final status event. */
export const GET = route<Ctx>(async (req, { params }, me) => {
  const id = (await params).id;
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
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' },
  });
}, { perm: 'runs:read' });
