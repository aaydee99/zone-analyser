'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, Save, ShieldAlert, XCircle } from 'lucide-react';
import { api } from '@/lib/client';
import { Alert, Badge, Button, Card, Field, Loading, PageHeader, SectionHeader, Skeleton, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { ToolsPanel } from '@/components/tools-panel';
import { useMe } from '@/components/me';
import type { WorkerSummary } from '@/lib/live-state';

interface Settings { sessionIdleMinutes: number; vaultAutoLockMinutes: number; outputDir: string; pluginCacheDir: string }
interface Check { ok: boolean; detail: string }
interface PathSource { source: 'machine' | 'user' | 'login-shell' | 'process'; dirs: string[] }
interface SystemCheck {
  node: Check; terraform: Check; cfTerraforming: Check; script: Check; envOverride: Check;
  signupDisabled: Check; vaultKeyFile: Check; legacyVault: Check;
  path: { managed: string; sources: PathSource[] };
  outputDir: string; dataDir: string; platform: string;
}

const SOURCE_LABEL: Record<PathSource['source'], string> = {
  machine: 'System (machine)', user: 'User', 'login-shell': 'Login shell', process: 'Server process',
};

/** Read-only view of the PATH a run gets, as discovered from the operating system. */
function PathView({ path: p }: { path: SystemCheck['path'] }) {
  const [open, setOpen] = useState(false);
  const seen = new Set<string>();
  const groups = p.sources.map((s) => ({
    ...s,
    dirs: s.dirs.filter((d) => { const k = d.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }),
  })).filter((g) => g.dirs.length);
  const total = groups.reduce((n, g) => n + g.dirs.length, 0);
  return (
    <Card>
      <SectionHeader
        title="System PATH"
        description={`Read from the operating system on every run — ${total} directories, nothing to configure.`}
        aside={<Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'}</Button>}
      />
      <div className="px-5 py-4 text-[13px]">
        <div className="flex items-start gap-2">
          <Badge tone="signal">1st</Badge>
          <div className="min-w-0">
            <div className="text-ink-2">Console-managed tools</div>
            <div className="font-mono text-xs break-all text-muted">{p.managed}</div>
          </div>
        </div>
        {open && (
          <div className="mt-4 space-y-4">
            {groups.map((g) => (
              <div key={g.source}>
                <div className="eyebrow mb-1.5">{SOURCE_LABEL[g.source]}</div>
                <ul className="space-y-0.5">
                  {g.dirs.map((d) => <li key={d} className="font-mono text-xs break-all text-muted">{d}</li>)}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function FieldSkeleton() {
  return <div className="space-y-2"><Skeleton className="h-3 w-40" /><Skeleton className="h-10 w-full rounded-[9px]" /><Skeleton className="h-3 w-3/4" /></div>;
}

function CheckRow({ label, check, hint }: { label: string; check: Check; hint?: string }) {
  return (
    <div className="flex items-start gap-3 py-3">
      {check.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-bad" />}
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{label}</div>
        <div className={cx('mt-0.5 font-mono text-xs break-all', check.ok ? 'text-muted' : 'text-bad')}>{check.detail}</div>
        {!check.ok && hint && <div className="mt-1 text-xs text-ink-2">{hint}</div>}
      </div>
    </div>
  );
}

function MinutesField({ label, hint, value, onChange, max, disabled }: {
  label: string; hint: string; value: number; onChange: (v: number) => void; max: number; disabled: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input type="number" min={1} max={max} className="input !w-28 font-mono" value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="text-[13px] text-muted">minutes</span>
      </div>
    </Field>
  );
}

/** On Vercel: the worker that runs backups, restores and Cloudflare reads, and the IP to allow on IP-restricted tokens. */
function WorkerCard({ w }: { w: WorkerSummary }) {
  return (
    <Card className="mb-6">
      <SectionHeader title="Worker" description="This deployment hands backups, restores, the vault and every Cloudflare, R2 and S3 call to the worker, which runs them from its own server." />
      <dl className="grid gap-x-6 gap-y-3 p-5 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-muted">Status</dt><dd className="mt-0.5">{w.online ? <Badge tone="ok">online</Badge> : w.startingSince ? <Badge tone="warn">starting</Badge> : <Badge tone="neutral">stopped</Badge>}</dd></div>
        <div><dt className="text-muted">Machine</dt><dd className="mt-0.5 font-mono text-xs break-all text-ink-2">{w.hostname ?? 'never started'}</dd></div>
        <div><dt className="text-muted">Public IP</dt><dd className="mt-0.5 font-mono text-xs break-all text-ink-2">{w.publicIp ?? '—'}</dd></div>
        <div><dt className="text-muted">Last seen</dt><dd className="mt-0.5 text-xs text-ink-2">{w.lastSeen ? new Date(w.lastSeen).toLocaleString() : '—'}</dd></div>
        <div className="sm:col-span-2 lg:col-span-4"><dt className="text-muted">Tools on the worker</dt><dd className="mt-0.5 text-xs text-ink-2">{w.tools?.length ? w.tools.map((t) => `${t.name} ${t.version ? `v${t.version}` : '(installing)'}`).join(' · ') : 'installed when the worker starts'}</dd></div>
      </dl>
      <p className="border-t border-line px-5 py-3 text-xs text-muted">
        {w.id === 'github-actions' || w.publicIp === null
          ? 'Every Cloudflare, R2 and S3 call is made from the worker. On GitHub Actions its outgoing IP changes with every run, so do not restrict the API tokens to client IPs.'
          : <>Every Cloudflare, R2 and S3 call is made from the worker, last seen at <span className="font-mono text-ink-2">{w.publicIp}</span>. Restrict tokens to that IP only if the worker has a fixed IP.</>}
        {!w.online && (w.onDemand ? ' It starts on GitHub Actions when someone opens the console, and stops itself after 20 idle minutes.' : ' Set up starting it on GitHub Actions (README, Worker).')}
      </p>
    </Card>
  );
}

export default function SettingsPage() {
  const toast = useToast();
  const { can, worker } = useMe();
  const editable = can('settings:write');
  const [loadError, setLoadError] = useState('');
  const [s, setS] = useState<Settings | null>(null);
  const [defaultOut, setDefaultOut] = useState('');
  const [sys, setSys] = useState<SystemCheck | null>(null);
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try { setSys((await api<{ check: SystemCheck }>('/api/system')).check); } finally { setChecking(false); }
  }, []);

  useEffect(() => {
    api<{ settings: Settings; defaultOutputDir: string }>('/api/settings').then((r) => { setS(r.settings); setDefaultOut(r.defaultOutputDir); }).catch((e) => setLoadError((e as Error).message));
    check();
  }, [check]);

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      setS((await api<{ settings: Settings }>('/api/settings', { method: 'PUT', json: s })).settings);
      toast('Settings saved');
      check();
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setSaving(false); }
  };

  return (
    <div className="rise">
      <PageHeader eyebrow="Configuration" title="Settings" description={editable ? 'Runtime paths, session timeouts and prerequisite checks. Stored in Supabase.' : 'Read-only — only admins can change settings.'} />

      {worker && <WorkerCard w={worker} />}

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card>
            <SectionHeader title="Runtime" description="Applied to every backup run." />
            {!s && loadError && <div className="p-5"><Alert tone="bad" title="Settings could not be read">{loadError}</Alert></div>}
            {!s && !loadError && <Loading label="Loading runtime settings" className="space-y-5 p-5">{[0, 1].map((i) => <FieldSkeleton key={i} />)}</Loading>}
            {s && (
              <div className="space-y-5 p-5">
                <Field label="Default output directory" hint={`OUTPUT_DIR when a run leaves it blank. Blank here = ${defaultOut}`}>
                  <input className="input font-mono !text-[13px]" disabled={!editable} value={s.outputDir} onChange={(e) => setS({ ...s, outputDir: e.target.value })} placeholder={defaultOut} />
                </Field>
                <Field label="Terraform plugin cache" optional hint="TF_PLUGIN_CACHE_DIR — one provider download shared by every zone folder. Blank = <data>/plugin-cache">
                  <input className="input font-mono !text-[13px]" disabled={!editable} value={s.pluginCacheDir} onChange={(e) => setS({ ...s, pluginCacheDir: e.target.value })} />
                </Field>
                {editable && <div className="flex justify-end"><Button variant="primary" loading={saving} icon={<Save className="size-4" />} onClick={save}>Save settings</Button></div>}
              </div>
            )}
          </Card>

          <Card>
            <SectionHeader title="Sessions" description="Idle timeouts. Running backups are never interrupted." />
            {!s && !loadError && <Loading label="Loading session settings" className="space-y-5 p-5">{[0, 1].map((i) => <FieldSkeleton key={i} />)}</Loading>}
            {s && (
              <div className="space-y-5 p-5">
                <MinutesField label="Sign users out after inactivity" max={30} disabled={!editable}
                  hint="Applies to every role, at most 30 minutes. Sessions also end 12 hours after sign-in." value={s.sessionIdleMinutes} onChange={(v) => setS({ ...s, sessionIdleMinutes: v })} />
                <MinutesField label="Lock the vault after inactivity" max={1440} disabled={!editable}
                  hint="Super admins must re-enter the vault password after this. Backups and presets keep working while it is locked."
                  value={s.vaultAutoLockMinutes} onChange={(v) => setS({ ...s, vaultAutoLockMinutes: v })} />
                {editable && <div className="flex justify-end"><Button variant="primary" loading={saving} icon={<Save className="size-4" />} onClick={save}>Save settings</Button></div>}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <ToolsPanel onChange={check} />
          <Card>
            <SectionHeader
              title="Environment"
              description={sys?.platform}
              aside={<Button size="sm" variant="ghost" loading={checking} icon={<RefreshCw className="size-3.5" />} onClick={check}>Re-check</Button>}
            />
            {!sys && checking && (
              <Loading label="Checking the environment" className="divide-y divide-line/70 px-5">
                {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                  <div key={i} className="flex items-start gap-3 py-3">
                    <Skeleton className="mt-0.5 size-4 shrink-0 rounded-full" />
                    <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-44" /><Skeleton className="h-3 w-32" /></div>
                  </div>
                ))}
              </Loading>
            )}
            {sys && (
              <div className="divide-y divide-line/70 px-5">
                <CheckRow label="Node.js ≥ 18" check={sys.node} />
                <CheckRow label="Terraform ≥ 1.5" check={sys.terraform} />
                <CheckRow label="cf-terraforming ≥ 0.30" check={sys.cfTerraforming} />
                <CheckRow label="Backup script" check={sys.script} />
                <CheckRow label="No .env next to the script" check={{ ok: sys.envOverride.ok, detail: sys.envOverride.ok ? 'vault credentials take effect' : `${sys.envOverride.detail} exists — it would override the vault` }} />
                <CheckRow label="Supabase public sign-up disabled" check={sys.signupDisabled} />
                <CheckRow label="Vault server key" check={sys.vaultKeyFile} />
                <CheckRow label="No leftover local vault" check={sys.legacyVault} />
              </div>
            )}
          </Card>

          {sys && <PathView path={sys.path} />}

          <Card>
            <SectionHeader title="Storage" description="Where this console keeps its own data." />
            {!sys && checking && (
              <Loading label="Loading storage locations" className="space-y-3 p-5">
                {[0, 1, 2].map((i) => <div key={i} className="space-y-1.5"><Skeleton className="h-3 w-52" /><Skeleton className="h-3 w-64 max-w-full" /></div>)}
              </Loading>
            )}
            {sys && (
              <dl className="space-y-3 p-5 text-[13px]">
                <div><dt className="text-muted">Users, vault, presets, runs, logs, audit</dt><dd className="mt-0.5 text-xs text-ink-2">Supabase (row-level security on, server-only access)</dd></div>
                <div><dt className="text-muted">Local: managed tools, plugin cache</dt><dd className="mt-0.5 font-mono text-xs break-all text-ink-2">{sys.dataDir}</dd></div>
                <div><dt className="text-muted">Default backup output</dt><dd className="mt-0.5 font-mono text-xs break-all text-ink-2">{sys.outputDir}</dd></div>
              </dl>
            )}
          </Card>

          <Alert tone="info" title="Security model">
            Sign-in is verified by Supabase Auth; roles are enforced on the server for every request. Credentials are encrypted
            with AES-256-GCM before they reach Supabase. Only super admins can open the vault, with a separate vault password;
            backups decrypt secrets on the server with the vault server key kept in Supabase, inject them into the
            backup process and scrub them from every log line.
          </Alert>
          <div className="flex items-start gap-2 px-1 text-xs text-muted">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            Keep the Supabase service-role key secret: with it, the vault server key and the vault can be read. Keep the vault password somewhere safe too.
          </div>
        </div>
      </div>
    </div>
  );
}
