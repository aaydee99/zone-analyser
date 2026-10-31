'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle, Download, PackageCheck, Trash2 } from 'lucide-react';
import { api, relTime } from '@/lib/client';
import { Badge, Button, Card, Loading, SectionHeader, Skeleton } from './ui';
import { useToast } from './toast';
import { useMe } from './me';

interface ToolStatus {
  name: 'terraform' | 'cf-terraforming';
  installed: boolean;
  version?: string;
  installedAt?: string;
  source?: string;
  latest?: string;
  updateAvailable?: boolean;
}

const ABOUT: Record<ToolStatus['name'], string> = {
  terraform: 'HashiCorp release · verified against SHA256SUMS',
  'cf-terraforming': 'Cloudflare GitHub release · verified against checksums.txt',
};

export function ToolsPanel({ onChange }: { onChange?: () => void }) {
  const toast = useToast();
  const manage = useMe().can('tools:manage');
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => api<{ tools: ToolStatus[] }>('/api/tools?latest=1').then((r) => setTools(r.tools)), []);
  useEffect(() => { load().catch((e) => toast(e.message, 'bad')); }, [load, toast]);

  const act = async (tool: ToolStatus['name'], action: 'install' | 'remove') => {
    setBusy(tool);
    try {
      const r = await api<{ tool?: ToolStatus }>('/api/tools', { method: 'POST', json: { tool, action } });
      toast(action === 'install' ? `${tool} ${r.tool?.version} installed` : `${tool} removed`);
      await load();
      onChange?.();
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <SectionHeader
        title="Managed tools"
        description="Downloaded from the official releases into the console's data folder. Missing tools are fetched automatically when a backup starts — no system install or PATH setup."
      />
      <div className="divide-y divide-line/70">
        {(tools ?? []).map((t) => (
          <div key={t.name} className="flex flex-wrap items-center gap-4 px-5 py-4">
            <div className="grid size-9 place-items-center rounded-lg border border-line-strong bg-raised">
              <PackageCheck className={t.installed ? 'size-[18px] text-ok' : 'size-[18px] text-faint'} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13.5px] font-medium">{t.name}</span>
                {t.installed ? <Badge tone="ok">v{t.version}</Badge> : <Badge tone="warn">not installed</Badge>}
                {t.updateAvailable && <Badge tone="signal">v{t.latest} available</Badge>}
              </div>
              <div className="mt-0.5 text-xs text-muted">
                {t.installed ? `Installed ${relTime(t.installedAt)} · ${ABOUT[t.name]}` : `Latest: ${t.latest ? `v${t.latest}` : 'unknown (offline?)'} · ${ABOUT[t.name]}`}
              </div>
            </div>
            <div className={manage ? 'flex gap-1.5' : 'hidden'}>
              {t.installed && (
                <Button size="sm" variant="ghost" className="hover:!text-bad" disabled={!!busy} icon={<Trash2 className="size-3.5" />} onClick={() => act(t.name, 'remove')} aria-label={`Remove ${t.name}`} />
              )}
              {(!t.installed || t.updateAvailable) && (
                <Button
                  size="sm" variant={t.installed ? 'secondary' : 'primary'} loading={busy === t.name} disabled={!!busy && busy !== t.name}
                  icon={t.installed ? <ArrowUpCircle className="size-3.5" /> : <Download className="size-3.5" />}
                  onClick={() => act(t.name, 'install')}
                >
                  {busy === t.name ? 'Downloading…' : t.installed ? 'Update' : 'Install'}
                </Button>
              )}
            </div>
          </div>
        ))}
        {!tools && (
          <Loading label="Checking installed versions">
            {[0, 1].map((i) => (
              <div key={i} className="flex items-center gap-4 border-b border-line/70 px-5 py-4 last:border-0">
                <Skeleton className="size-9 shrink-0 rounded-lg" />
                <div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-36" /><Skeleton className="h-3 w-3/4" /></div>
              </div>
            ))}
          </Loading>
        )}
      </div>
    </Card>
  );
}
