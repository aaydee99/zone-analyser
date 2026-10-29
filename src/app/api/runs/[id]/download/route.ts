import { HttpError, route } from '@/lib/http';
import { getRun } from '@/lib/runner';
import { zipBackup } from '@/lib/backup-files';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }, me) => {
  const run = await getRun((await params).id);
  if (!run) throw new HttpError(404, 'Run not found');
  if (run.status === 'running') throw new HttpError(409, 'Wait for the run to finish');
  const { name, data } = zipBackup(run);
  await audit(me, 'run.downloaded', run.id);
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Content-Length': String(data.length),
    },
  });
}, { perm: 'runs:read' });
