'use client';

import { useEffect, useMemo, useState } from 'react';
import { Copy, Download, FileCode2, FileJson, FileText, Search } from 'lucide-react';
import { api, copyText } from '@/lib/client';
import { Badge, Button, ButtonLink, Card, Loading, Modal, Skeleton, cx } from './ui';
import { useToast } from './toast';

interface BackupFile { path: string; size: number }
interface Viewed { path: string; size: number; truncated: boolean; binary: boolean; content: string }

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const iconFor = (p: string) => (p.endsWith('.tf') || p.endsWith('.hcl') ? FileCode2 : p.endsWith('.json') ? FileJson : FileText);
const flagged = (p: string) => /\.(error|broken)$|_generate_failures\.txt$|_api_errors\.tsv$/.test(p);

export function BackupFiles({ runId }: { runId: string }) {
  const toast = useToast();
  const [files, setFiles] = useState<BackupFile[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [viewing, setViewing] = useState<Viewed | null>(null);

  useEffect(() => {
    api<{ files: BackupFile[] }>(`/api/runs/${runId}/files`).then((r) => setFiles(r.files)).catch((e) => setError(e.message));
  }, [runId]);

  const shown = useMemo(() => (files ?? []).filter((f) => (!q || f.path.toLowerCase().includes(q.toLowerCase())) && (!onlyIssues || flagged(f.path))), [files, q, onlyIssues]);
  const total = useMemo(() => (files ?? []).reduce((n, f) => n + f.size, 0), [files]);
  const issues = useMemo(() => (files ?? []).filter((f) => flagged(f.path)).length, [files]);

  const open = async (p: string) => {
    try { setViewing((await api<{ file: Viewed }>(`/api/runs/${runId}/files?path=${encodeURIComponent(p)}`)).file); } catch (e) { toast((e as Error).message, 'bad'); }
  };

  if (error) return <Card className="px-5 py-4 text-[13px] text-muted">Backup files: {error}</Card>;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold">Backup files</h2>
          {files ? <p className="mt-0.5 text-xs text-muted">{`${files.length} files · ${fmtSize(total)}`}</p> : <Skeleton className="mt-1.5 h-3 w-28" />}
        </div>
        <ButtonLink href={`/api/runs/${runId}/download`} download variant="primary" icon={<Download className="size-4" />} disabled={!files?.length}>Download .zip</ButtonLink>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input className="input !pl-9 !text-[13px]" placeholder="Filter files…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button onClick={() => setOnlyIssues((v) => !v)} className={cx('rounded-lg border px-3 py-2 text-[13px]', onlyIssues ? 'border-warn/40 bg-warn/10 text-warn' : 'border-line text-muted hover:text-ink-2')}>
          Issues only <span className="ml-1 font-mono text-[11px]">{issues}</span>
        </button>
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        {!files && (
          <Loading label="Loading backup files">
            {[52, 40, 64, 46, 58, 36].map((w, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-line/50 px-5 py-2.5 last:border-0">
                <Skeleton className="size-4 shrink-0" /><Skeleton className="h-3" style={{ width: `${w}%` }} /><Skeleton className="ml-auto h-3 w-12 shrink-0" />
              </div>
            ))}
          </Loading>
        )}
        {shown.map((f) => {
          const Icon = iconFor(f.path);
          const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
          return (
            <button key={f.path} onClick={() => open(f.path)} className="flex w-full items-center gap-3 border-b border-line/50 px-5 py-2 text-left last:border-0 hover:bg-raised/50">
              <Icon className={cx('size-4 shrink-0', flagged(f.path) ? 'text-warn' : 'text-faint')} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                <span className="text-faint">{dir}</span><span className="text-ink-2">{f.path.slice(dir.length)}</span>
              </span>
              <span className="shrink-0 font-mono text-[11px] text-faint">{fmtSize(f.size)}</span>
            </button>
          );
        })}
        {files && shown.length === 0 && <div className="px-5 py-6 text-sm text-muted">No files match.</div>}
      </div>

      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing?.path.split('/').pop() ?? ''} description={viewing ? `${viewing.path} · ${fmtSize(viewing.size)}` : ''} width="max-w-5xl">
        {viewing && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              {viewing.truncated && <Badge tone="warn">Showing first 2 MB — download the zip for the full file</Badge>}
              {!viewing.binary && (
                <Button size="sm" variant="ghost" className="ml-auto" icon={<Copy className="size-3.5" />} onClick={async () => { await copyText(viewing.content); toast('Copied'); }}>Copy</Button>
              )}
            </div>
            {viewing.binary ? <p className="text-sm text-muted">Binary file — not shown.</p> : (
              <pre className="max-h-[60vh] overflow-auto rounded-lg border border-line bg-canvas p-4 font-mono text-[12px] leading-relaxed whitespace-pre text-ink-2">{viewing.content}</pre>
            )}
          </div>
        )}
      </Modal>
    </Card>
  );
}
