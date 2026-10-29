import { HttpError, route } from '@/lib/http';
import { getRun } from '@/lib/runner';
import { listBackupFiles, readBackupFile } from '@/lib/backup-files';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** No ?path → file list; ?path=<relative> → that file's contents. */
export const GET = route<Ctx>(async (req, { params }) => {
  const run = await getRun((await params).id);
  if (!run) throw new HttpError(404, 'Run not found');
  const rel = new URL(req.url).searchParams.get('path');
  return rel ? { file: readBackupFile(run, rel) } : listBackupFiles(run);
}, { perm: 'runs:read' });
