'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle, Archive, BookmarkPlus, Cloud, Copy, Database, FolderOutput, Globe2, Loader2, Play, RefreshCw, Search, Trash2,
} from 'lucide-react';
import { api, copyText, relTime } from '@/lib/client';
import type { Approval } from '@/lib/approvals-store';
import {
  DEFAULT_CONFIG, ZONE_STATUSES, buildArgs, includesAccount, normalizeConfig, validateConfig, type BackupConfig, type ZoneStatus,
} from '@/lib/config';
import type { CredentialOption } from '@/lib/kinds';
import type { RunMeta } from '@/lib/run-types';
import {
  Alert, Badge, Button, Card, Checkbox, CheckboxBox, EmptyState, Field, FlagCard, Modal, PageHeader, SectionHeader, Segmented, Switch, cx,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { useMe } from '@/components/me';

interface Zone { id: string; name: string; status: string; plan: string; paused: boolean; accountId?: string; accountName?: string }
interface Preset { id: string; name: string; config: BackupConfig; updatedAt: string }

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = { active: 'ok', pending: 'warn', initializing: 'warn', moved: 'bad', deactivated: 'neutral' };

/** Credentials by name only — the values stay on the server, so any role that can run backups may pick one. */
/** An upload on/off flag that says which state it is in. */
function UploadSwitch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={cx('flex shrink-0 items-center gap-2', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
      <span className={cx('w-7 text-right font-mono text-[11px] font-semibold', checked ? 'text-signal' : 'text-faint')}>{checked ? 'ON' : 'OFF'}</span>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </label>
  );
}

/** Buckets approved on the account set's storage; blank value = its default bucket. */
function BucketSelect({ id, buckets, value, onChange }: { id: string; buckets: string[]; value: string; onChange: (v: string) => void }) {
  if (!buckets.length) return <p className="py-2 text-[13px] text-muted">The account set&apos;s default bucket.</p>;
  // A preset may name a bucket that is no longer approved: show it so the problem is visible.
  const unknown = value && !buckets.includes(value);
  return (
    <>
      <select id={id} className="input font-mono !text-[13px]" value={value || buckets[0]} onChange={(e) => onChange(e.target.value === buckets[0] ? '' : e.target.value)}>
        {buckets.map((b, i) => <option key={b} value={b}>{b}{i === 0 ? ' (default)' : ''}</option>)}
        {unknown && <option value={value}>{value} (no longer approved)</option>}
      </select>
      {unknown && <p className="mt-1 text-xs text-bad">“{value}” is no longer approved on this account set — choose another bucket.</p>}
    </>
  );
}

function CredentialSelect({ value, onChange, options, empty }:{ value: string; onChange: (v: string) => void; options: CredentialOption[]; empty: string }) {
  const { can } = useMe();
  if (!options.length) {
    return (
      <div className="flex items-center justify-between rounded-[9px] border border-dashed border-line-strong px-3 py-2.5 text-[13px] text-muted">
        {empty}
        {can('vault:access')
          ? <Link href="/vault" className="font-medium text-signal hover:underline">Add an account set →</Link>
          : <span className="text-xs text-faint">Ask a super admin to add one</span>}
      </div>
    );
  }
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select an account set…</option>
      {options.map((c) => (
        <option key={c.id} value={c.id}>{c.name}{c.tested === false ? ' (failing)' : ''}</option>
      ))}
    </select>
  );
}

interface AccountOption { id: string; name: string; zones: number }
interface ZoneList {
  credentialId: string;
  zones: Zone[] | null;
  accounts: AccountOption[];
  /** The set has no account ID: it covers every account its token can access. */
  allAccounts: boolean;
  loading: boolean;
  error: string;
  reload: () => void;
}

/** The account set's zones and accounts, read from Cloudflare on the server. */
function useZoneList(credentialId: string): ZoneList {
  const [data, setData] = useState<{ zones: Zone[]; accounts: AccountOption[]; allAccounts: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    if (!credentialId) { setData(null); return; }
    setLoading(true);
    setError('');
    try {
      const r = await api<{ zones: Zone[]; accounts?: AccountOption[]; allAccounts?: boolean }>(`/api/zones?credentialId=${encodeURIComponent(credentialId)}`);
      setData({ zones: r.zones, accounts: r.accounts ?? [], allAccounts: !!r.allAccounts });
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [credentialId]);
  useEffect(() => { reload(); }, [reload]);
  return { credentialId, zones: data?.zones ?? null, accounts: data?.accounts ?? [], allAccounts: !!data?.allAccounts, loading, error, reload };
}

function ZonePicker({ list, accountId, selected, onChange }: { list: ZoneList; accountId: string; selected: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState('');
  const [manual, setManual] = useState('');
  const { loading, error, reload: load, credentialId } = list;
  // Only the chosen account's zones (all of the set's accounts when none is chosen).
  const zones = useMemo(() => (list.zones && accountId ? list.zones.filter((z) => z.accountId === accountId) : list.zones), [list.zones, accountId]);

  const shown = useMemo(() => (zones ?? []).filter((z) => !q || z.name.toLowerCase().includes(q.toLowerCase()) || z.id.startsWith(q.toLowerCase()) || !!z.accountName?.toLowerCase().includes(q.toLowerCase())), [zones, q]);
  // A credential without an account ID lists zones from several accounts: name the account on each.
  const multiAccount = new Set((zones ?? []).map((z) => z.accountId)).size > 1;
  const sel = new Set(selected);
  const allShown = shown.length > 0 && shown.every((z) => sel.has(z.id));
  const someShown = shown.some((z) => sel.has(z.id));
  const unknown = selected.filter((id) => !zones?.some((z) => z.id === id));

  const toggle = (id: string, on: boolean) => onChange(on ? [...selected, id] : selected.filter((x) => x !== id));
  const addManual = () => {
    const ids = manual.toLowerCase().split(/[\s,]+/).filter((s) => /^[0-9a-f]{32}$/.test(s));
    if (ids.length) onChange([...new Set([...selected, ...ids])]);
    setManual('');
  };

  if (!credentialId) return <p className="text-[13px] text-muted">Choose a Cloudflare credential first to list its zones.</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input className="input !pl-9" placeholder="Search zones by name or ID" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button size="md" variant="ghost" onClick={load} loading={loading} icon={<RefreshCw className="size-4" />}>Refresh</Button>
      </div>

      {error && <Alert tone="bad" title="Could not list zones">{error}. You can still paste zone IDs below.</Alert>}

      <div className="overflow-hidden rounded-xl border border-line">
        <div className="flex items-center justify-between border-b border-line bg-raised/60 px-4 py-2.5">
          <Checkbox
            checked={allShown} indeterminate={!allShown && someShown}
            onChange={(v) => onChange(v ? [...new Set([...selected, ...shown.map((z) => z.id)])] : selected.filter((id) => !shown.some((z) => z.id === id)))}
            label={<span className="text-[13px] font-medium">{allShown ? 'Deselect' : 'Select'} {q ? 'matching' : 'all'}</span>}
          />
          <span className="font-mono text-xs text-muted">{selected.length} selected{zones ? ` / ${zones.length}` : ''}</span>
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          {loading && !zones && <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Loading zones from Cloudflare…</div>}
          {zones && shown.length === 0 && <div className="px-4 py-6 text-sm text-muted">No zones match.</div>}
          {shown.map((z) => (
            <button
              type="button" key={z.id} role="checkbox" aria-checked={sel.has(z.id)} onClick={() => toggle(z.id, !sel.has(z.id))}
              className={cx('group flex w-full items-center gap-3 border-b border-line/60 px-4 py-2.5 text-left last:border-0 hover:bg-raised/50', sel.has(z.id) && 'bg-signal/[0.04]')}
            >
              <CheckboxBox checked={sel.has(z.id)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{z.name}</span>
                <span className="block font-mono text-[11px] text-faint">{z.id}{multiAccount && z.accountName ? <span className="font-sans"> · {z.accountName}</span> : null}</span>
              </span>
              {z.plan && <span className="hidden text-xs text-muted sm:inline">{z.plan}</span>}
              <Badge tone={STATUS_TONE[z.status] ?? 'neutral'}>{z.status}{z.paused ? ' · paused' : ''}</Badge>
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <input className="input font-mono !text-[13px]" placeholder="Paste zone IDs (space or comma separated)" value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }} />
        <Button onClick={addManual} disabled={!manual.trim()}>Add</Button>
      </div>
      {unknown.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {unknown.map((id) => (
            <button key={id} onClick={() => toggle(id, false)} className="inline-flex items-center gap-1 rounded-md border border-line-strong bg-raised px-2 py-1 font-mono text-[11px] text-ink-2 hover:border-bad/40 hover:text-bad" title="Remove">
              {id.slice(0, 12)}… ×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className="text-right text-ink">{children}</span>
    </div>
  );
}

function BackupBuilder() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const [cfg, setCfg] = useState<BackupConfig>(DEFAULT_CONFIG);
  const { can, activeRunId: liveRun, activeRestore } = useMe();
  const [creds, setCreds] = useState<CredentialOption[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState('');
  const [defaultOut, setDefaultOut] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [starting, setStarting] = useState(false);
  // Operators ask for approval; the run starts when an admin or super admin approves it.
  const needsApproval = !can('runs:approve');
  const [request, setRequest] = useState<Approval | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  // Only one job at a time: the shell keeps these current (a backup run, or a restore job).
  const activeRun = liveRun;

  const set = <K extends keyof BackupConfig>(k: K, v: BackupConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const setR2 = (p: Partial<BackupConfig['r2']>) => setCfg((c) => ({ ...c, r2: { ...c.r2, ...p } }));
  const setAws = (p: Partial<BackupConfig['aws']>) => setCfg((c) => ({ ...c, aws: { ...c.aws, ...p } }));

  useEffect(() => {
    (async () => {
      const [c, p, s] = await Promise.all([
        api<{ options: CredentialOption[] }>('/api/credentials/options'),
        api<{ presets: Preset[] }>('/api/presets'),
        api<{ settings: { outputDir: string }; defaultOutputDir: string }>('/api/settings'),
      ]);
      setCreds(c.options);
      setPresets(p.presets);
      setDefaultOut(s.settings.outputDir || s.defaultOutputDir);

      const fromPreset = params.get('preset');
      const fromRun = params.get('from');
      if (fromPreset) {
        const pr = p.presets.find((x) => x.id === fromPreset);
        if (pr) { setCfg(normalizeConfig(pr.config)); setPresetId(pr.id); }
      } else if (fromRun) {
        try {
          const { run } = await api<{ run: RunMeta }>(`/api/runs/${encodeURIComponent(fromRun)}`);
          setCfg(normalizeConfig(run.config));
        } catch { /* ignore */ }
      } else {
        const firstCf = c.options.find((x) => x.kind === 'cloudflare');
        if (firstCf) setCfg((x) => ({ ...x, cloudflareCredentialId: firstCf.id }));
      }
    })().catch((e) => toast(e.message, 'bad'));
  }, [params, toast]);

  const byKind = (k: CredentialOption['kind']) => creds.filter((c) => c.kind === k);
  const credName = (id: string) => creds.find((c) => c.id === id)?.name;
  /** The account set's storage: its approved buckets (default first), or undefined when it has none. */
  const storageOf = (k: 'r2' | 'aws') => creds.find((c) => c.id === cfg.cloudflareCredentialId)?.storage?.[k];
  /** The bucket a run will use: the chosen one, else the account set's default. */
  const bucketOf = (k: 'r2' | 'aws') => cfg[k].bucket || storageOf(k)?.[0] || '';

  const problems = validateConfig(cfg);
  const account = includesAccount(cfg);
  const selectedMode = cfg.zoneMode === 'selected';
  const zoneList = useZoneList(cfg.cloudflareCredentialId);
  const chosenAccount = zoneList.accounts.find((a) => a.id === cfg.accountId);
  const chooseAccount = (id: string) => setCfg((c) => ({
    ...c, accountId: id,
    // Chosen zones outside the account are dropped.
    zoneIds: id ? c.zoneIds.filter((z) => zoneList.zones?.find((x) => x.id === z)?.accountId === id) : c.zoneIds,
  }));

  const command = useMemo(() => {
    const env: string[] = [];
    if (cfg.accountScope !== 'auto') env.push(`BACKUP_ACCOUNT=${cfg.accountScope}`);
    if (!selectedMode) {
      if (cfg.statusFilter !== 'all') env.push(`ZONE_STATUS_FILTER=${cfg.statusFilter}`);
      if (cfg.statusExclude.join(' ') !== 'moved') env.push(`ZONE_STATUS_EXCLUDE="${cfg.statusExclude.join(' ')}"`);
      if (cfg.nameFilter.trim() && cfg.nameFilter.trim() !== '*') env.push(`ZONE_NAME_FILTER="${cfg.nameFilter.trim()}"`);
    }
    if (cfg.auditLogHours !== 72) env.push(`AUDIT_LOG_HOURS=${cfg.auditLogHours}`);
    env.push(`R2_SKIP_UPLOAD=${cfg.r2.enabled ? 'false' : 'true'}`);
    if (cfg.r2.enabled && bucketOf('r2')) env.push(`R2_BUCKET_NAME=${bucketOf('r2')}`);
    env.push(`AWS_SKIP_UPLOAD=${cfg.aws.enabled ? 'false' : 'true'}`);
    if (cfg.aws.enabled && bucketOf('aws')) env.push(`AWS_S3_BUCKET=${bucketOf('aws')}`);
    const args = buildArgs(cfg).map((a) => (/^[0-9a-f]{32}$/.test(a) ? `${a.slice(0, 8)}…` : a));
    return [...env, 'node backup.js', ...args].join(' ');
  }, [cfg, selectedMode, creds]);

  const loadPreset = (id: string) => {
    setPresetId(id);
    const p = presets.find((x) => x.id === id);
    if (p) { setCfg(normalizeConfig(p.config)); toast(`Loaded preset "${p.name}"`, 'info'); }
  };

  const savePreset = async () => {
    try {
      const existing = presets.find((p) => p.name.toLowerCase() === presetName.trim().toLowerCase());
      const { preset } = await api<{ preset: Preset }>('/api/presets', { method: 'POST', json: { name: presetName, config: cfg, id: existing?.id } });
      setPresets((ps) => [...ps.filter((p) => p.id !== preset.id), preset]);
      setPresetId(preset.id);
      setSaveOpen(false);
      toast(existing ? `Preset "${preset.name}" updated` : `Preset "${preset.name}" saved`);
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  const deletePreset = async () => {
    const p = presets.find((x) => x.id === presetId);
    if (!p || !confirm(`Delete preset "${p.name}"?`)) return;
    await api(`/api/presets/${p.id}`, { method: 'DELETE' });
    setPresets((ps) => ps.filter((x) => x.id !== p.id));
    setPresetId('');
    toast('Preset deleted');
  };

  const start = async () => {
    setStarting(true);
    try {
      const r = await api<{ run?: RunMeta; approval?: Approval }>('/api/runs', {
        method: 'POST', json: { config: cfg, presetName: presets.find((p) => p.id === presetId)?.name },
      });
      if (r.run) { router.push(`/runs/${r.run.id}`); return; }
      if (r.approval) {
        setRequest(r.approval);
        try { sessionStorage.setItem('backup.request', r.approval.id); } catch { /* storage blocked */ }
        toast('Backup requested — it starts when an admin approves it', 'info');
      }
      setStarting(false);
    } catch (e) {
      toast((e as Error).message, 'bad');
      setStarting(false);
    }
  };

  // A request sent from this tab: follow it until it is decided; approved → open the run.
  useEffect(() => {
    if (!needsApproval || request) return;
    let saved: string | null = null;
    try { saved = sessionStorage.getItem('backup.request'); } catch { /* storage blocked */ }
    if (saved) api<{ approval: Approval }>(`/api/approvals/${saved}`).then((r) => setRequest(r.approval)).catch(() => {});
  }, [needsApproval]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!request || request.status !== 'pending') return;
    const t = setInterval(() => {
      api<{ approval: Approval }>(`/api/approvals/${request.id}`).then((r) => {
        setRequest(r.approval);
        if (r.approval.status === 'approved' && r.approval.runId) {
          try { sessionStorage.removeItem('backup.request'); } catch { /* storage blocked */ }
          toast(`Approved by ${r.approval.decidedBy?.email} — the backup is running`, 'ok');
          router.push(`/runs/${r.approval.runId}`);
        }
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [request, router, toast]);
  const withdrawRequest = async () => {
    if (!request) return;
    setWithdrawing(true);
    try { setRequest((await api<{ approval: Approval }>(`/api/approvals/${request.id}/withdraw`, { method: 'POST' })).approval); toast('Request withdrawn', 'info'); }
    catch (e) { toast((e as Error).message, 'bad'); } finally { setWithdrawing(false); }
  };
  const clearRequest = () => { setRequest(null); try { sessionStorage.removeItem('backup.request'); } catch { /* storage blocked */ } };

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Backup"
        title="New backup run"
        description="Every option of backup.js, as switches. Credentials are pulled from the vault and injected into the run — they never appear in the command line or logs."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select className="input !w-auto min-w-[180px]" value={presetId} onChange={(e) => loadPreset(e.target.value)}>
              <option value="">{presets.length ? 'Load preset…' : 'No presets yet'}</option>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {presetId && can('presets:write') && <Button variant="ghost" onClick={deletePreset} aria-label="Delete preset" icon={<Trash2 className="size-4" />} />}
            {can('presets:write') && <Button icon={<BookmarkPlus className="size-4" />} onClick={() => { setPresetName(presets.find((p) => p.id === presetId)?.name ?? ''); setSaveOpen(true); }}>Save preset</Button>}
          </div>
        }
      />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          {/* 1 — Source */}
          <Card>
            <SectionHeader step="01" title="Account set" description="One Cloudflare account (or every account its token can access) and its own storage, from the vault. Backups can only go to this set's buckets." />
            <div className="p-5">
              <CredentialSelect value={cfg.cloudflareCredentialId} options={byKind('cloudflare')} empty="No account sets in the vault yet."
                onChange={(v) => setCfg((c) => {
                  // Another set has other storage: drop the bucket choice, and turn off uploads it cannot do.
                  const st = creds.find((x) => x.id === v)?.storage ?? {};
                  return { ...c, cloudflareCredentialId: v, accountId: '', zoneIds: [], r2: { enabled: c.r2.enabled && !!st.r2, bucket: '' }, aws: { enabled: c.aws.enabled && !!st.aws, bucket: '' } };
                })} />
            </div>
          </Card>

          {/* 2 — Account */}
          <Card>
            <SectionHeader step="02" title="Account"
              description={zoneList.allAccounts
                ? 'This account set has no account ID: it covers every account its token can access. Back up one of them, or all (each into its own folder).'
                : 'The Cloudflare account this account set is for.'} />
            <div className="p-5">
              {!cfg.cloudflareCredentialId ? (
                <p className="text-[13px] text-muted">Choose an account set first.</p>
              ) : zoneList.loading && !zoneList.zones ? (
                <p className="flex items-center gap-2 text-[13px] text-muted"><Loader2 className="size-4 animate-spin" /> Reading the accounts and zones from Cloudflare…</p>
              ) : zoneList.error && !zoneList.zones ? (
                <Alert tone="bad" title="Could not read the accounts">{zoneList.error}</Alert>
              ) : (
                <Field label="Account" htmlFor="backup-account">
                  <select id="backup-account" className="input" value={zoneList.allAccounts ? cfg.accountId : zoneList.accounts[0]?.id ?? ''}
                    onChange={(e) => chooseAccount(e.target.value)} disabled={!zoneList.allAccounts}>
                    {zoneList.allAccounts && <option value="">All {zoneList.accounts.length} accounts{zoneList.zones ? ` (${zoneList.zones.length} zones)` : ''}</option>}
                    {zoneList.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.zones} zone{a.zones === 1 ? '' : 's'})</option>)}
                    {zoneList.allAccounts && cfg.accountId && !chosenAccount && zoneList.zones && <option value={cfg.accountId}>{cfg.accountId} (not accessible to this token)</option>}
                  </select>
                </Field>
              )}
            </div>
          </Card>

          {/* 3 — Zones */}
          <Card>
            <SectionHeader step="03" title="Zones"
              description={chosenAccount ? `Back up every zone of ${chosenAccount.name}, or pick specific ones.` : zoneList.allAccounts ? 'Back up every zone of every account, or pick specific ones.' : 'Back up every zone on the account, or pick specific ones.'} />
            <div className="space-y-5 p-5">
              <Segmented
                value={cfg.zoneMode}
                onChange={(v) => set('zoneMode', v)}
                options={[
                  { value: 'all', label: 'All zones', hint: chosenAccount ? `Every zone of ${chosenAccount.name}` : zoneList.allAccounts ? 'Every zone of every account' : 'Discovered via the API, then filtered' },
                  { value: 'selected', label: 'Chosen zones', hint: 'One or more · passed as -z <zone_id> flags' },
                ]}
              />
              {selectedMode ? (
                <ZonePicker list={zoneList} accountId={cfg.accountId} selected={cfg.zoneIds} onChange={(ids) => set('zoneIds', ids)} />
              ) : (
                <div className="grid gap-5 md:grid-cols-2">
                  <Field label="Only zones with status" hint="ZONE_STATUS_FILTER">
                    <select className="input" value={cfg.statusFilter} onChange={(e) => set('statusFilter', e.target.value as BackupConfig['statusFilter'])}>
                      <option value="all">Any status</option>
                      {ZONE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </Field>
                  <Field label="Zone name filter" hint={<>Shell glob, e.g. <code className="font-mono">*.example.com</code> · ZONE_NAME_FILTER</>}>
                    <input className="input font-mono" value={cfg.nameFilter} onChange={(e) => set('nameFilter', e.target.value)} placeholder="*" />
                  </Field>
                  <div className="md:col-span-2">
                    <div className="mb-2 text-[13px] font-medium text-ink-2">Skip zones with status <span className="ml-1 font-mono text-[11px] font-normal text-faint">ZONE_STATUS_EXCLUDE</span></div>
                    <div className="flex flex-wrap gap-2">
                      {ZONE_STATUSES.map((s) => {
                        const on = cfg.statusExclude.includes(s);
                        return (
                          <button
                            type="button" key={s} role="checkbox" aria-checked={on}
                            onClick={() => set('statusExclude', (on ? cfg.statusExclude.filter((x) => x !== s) : [...cfg.statusExclude, s]) as ZoneStatus[])}
                            className={cx('group inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] transition-colors', on ? 'border-signal/50 bg-signal/[0.06]' : 'border-line bg-sunken/60 hover:border-line-strong')}
                          >
                            <CheckboxBox checked={on} />
                            {s}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* 4 — Flags */}
          <Card>
            <SectionHeader step="04" title="Run options" description="Command-line flags and behaviour switches." />
            <div className="space-y-5 p-5">
              <div className="grid gap-3 md:grid-cols-2">
                <FlagCard
                  checked={cfg.importMode} onChange={(v) => set('importMode', v)}
                  flag={cfg.importMode ? '--import' : '--generate-only'}
                  title="Import mode"
                  description="Also write imports.tf in every Terraform folder and verify it with a read-only terraform plan. Off = generate .tf config and JSON dumps only."
                />
                <FlagCard
                  checked={cfg.withAccount} onChange={(v) => set('withAccount', v)}
                  flag="--with-account"
                  title="Include account-level resources"
                  description="Lists, Access, tunnels, Workers, IAM, R2 bucket metadata… Needed when backing up selected zones; all-zone runs include them automatically."
                  note={!selectedMode && cfg.accountScope === 'auto' ? 'Already included for all-zone runs.' : undefined}
                />
              </div>
              <Field label="Account-level resources policy" hint="BACKUP_ACCOUNT — overrides the default rule above">
                <Segmented
                  value={cfg.accountScope}
                  onChange={(v) => set('accountScope', v)}
                  options={[
                    { value: 'auto', label: 'Auto', hint: 'All-zone runs or --with-account' },
                    { value: 'true', label: 'Always', hint: 'Every run' },
                    { value: 'false', label: 'Never', hint: 'Unless --with-account' },
                  ]}
                />
              </Field>
              <Field label="Audit log window" hint="Hours of account audit logs to export · AUDIT_LOG_HOURS">
                <div className="flex items-center gap-3">
                  <input type="range" min={1} max={720} step={1} value={Math.min(cfg.auditLogHours, 720)} onChange={(e) => set('auditLogHours', Number(e.target.value))} className="flex-1 accent-[var(--color-signal)]" />
                  <div className="flex items-center gap-1.5">
                    <input type="number" min={1} max={2160} className="input !w-24 text-right font-mono" value={cfg.auditLogHours} onChange={(e) => set('auditLogHours', Math.round(Number(e.target.value)) || 1)} />
                    <span className="text-[13px] text-muted">h</span>
                  </div>
                </div>
              </Field>
            </div>
          </Card>

          {/* 5 — Output & uploads */}
          <Card>
            <SectionHeader step="05" title="Output & offsite copies" description="Where the backup lands, and optional uploads of its .tf files to R2 / S3." />
            <div className="space-y-5 p-5">
              <Field label="Output directory" optional hint={`Blank uses the console default: ${defaultOut}`}>
                <div className="relative">
                  <FolderOutput className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
                  <input className="input !pl-9 font-mono !text-[13px]" value={cfg.outputDir} onChange={(e) => set('outputDir', e.target.value)} placeholder={defaultOut} />
                </div>
              </Field>

              <div className={cx('rounded-xl border transition-colors', cfg.r2.enabled ? 'border-cyan/30 bg-cyan/[0.03]' : 'border-line')}>
                <div className="flex items-center gap-3 px-4 py-3.5">
                  <Archive className={cx('size-[18px]', cfg.r2.enabled ? 'text-cyan' : 'text-faint')} />
                  <div className="flex-1">
                    <div className="text-sm font-medium">Upload to Cloudflare R2 <code className="ml-1.5 font-mono text-[11px] text-faint">R2_SKIP_UPLOAD={cfg.r2.enabled ? 'false' : 'true'}</code></div>
                    <div className="text-xs text-muted">Only the .tf files are uploaded. The bucket is unlocked for the upload, then re-locked.</div>
                  </div>
                  <UploadSwitch checked={cfg.r2.enabled} onChange={(v) => setR2({ enabled: v })} label="Upload to R2" disabled={!storageOf('r2')} />
                </div>
                {!storageOf('r2') && <p className="border-t border-line px-4 py-2.5 text-xs text-muted">This account set has no R2 storage — a super admin can add it to the set in the vault.</p>}
                {cfg.r2.enabled && storageOf('r2') && (
                  <div className="grid gap-4 border-t border-line px-4 py-4 md:grid-cols-2">
                    <Field label="R2 bucket">
                      <BucketSelect id="r2-bucket" buckets={storageOf('r2') ?? []} value={cfg.r2.bucket} onChange={(v) => setR2({ bucket: v })} />
                    </Field>
                    <p className="self-center text-xs text-muted">Keys, endpoint, prefix and lock rules come from the account set; only the buckets approved there are offered.</p>
                  </div>
                )}
              </div>

              <div className={cx('rounded-xl border transition-colors', cfg.aws.enabled ? 'border-info/30 bg-info/[0.03]' : 'border-line')}>
                <div className="flex items-center gap-3 px-4 py-3.5">
                  <Database className={cx('size-[18px]', cfg.aws.enabled ? 'text-info' : 'text-faint')} />
                  <div className="flex-1">
                    <div className="text-sm font-medium">Upload to AWS S3 <code className="ml-1.5 font-mono text-[11px] text-faint">AWS_SKIP_UPLOAD={cfg.aws.enabled ? 'false' : 'true'}</code></div>
                    <div className="text-xs text-muted">Only the .tf files are uploaded, as signed SigV4 PUTs — no AWS CLI needed.</div>
                  </div>
                  <UploadSwitch checked={cfg.aws.enabled} onChange={(v) => setAws({ enabled: v })} label="Upload to AWS S3" disabled={!storageOf('aws')} />
                </div>
                {!storageOf('aws') && <p className="border-t border-line px-4 py-2.5 text-xs text-muted">This account set has no AWS S3 storage — a super admin can add it to the set in the vault.</p>}
                {cfg.aws.enabled && storageOf('aws') && (
                  <div className="grid gap-4 border-t border-line px-4 py-4 md:grid-cols-2">
                    <Field label="S3 bucket">
                      <BucketSelect id="aws-bucket" buckets={storageOf('aws') ?? []} value={cfg.aws.bucket} onChange={(v) => setAws({ bucket: v })} />
                    </Field>
                    <p className="self-center text-xs text-muted">Keys come from the account set; only the buckets approved there are offered. The default bucket uses the set&apos;s region; others are detected.</p>
                  </div>
                )}
              </div>
            </div>
          </Card>
        </div>

        {/* Plan */}
        <aside className="space-y-4 xl:sticky xl:top-8">
          <Card className="overflow-hidden">
            <div className="grid-bg border-b border-line px-5 py-4">
              <div className="eyebrow">Run plan</div>
              <div className="mt-1 text-[15px] font-semibold">{credName(cfg.cloudflareCredentialId) ?? 'No source selected'}</div>
            </div>
            <div className="divide-y divide-line/70 px-5 py-2">
              {zoneList.allAccounts && (
                <PlanRow label="Accounts">{chosenAccount ? chosenAccount.name : `All ${zoneList.accounts.length}, one after the other`}</PlanRow>
              )}
              <PlanRow label="Zones">
                {selectedMode ? `${cfg.zoneIds.length} selected` : (
                  <>All{cfg.statusFilter !== 'all' ? ` ${cfg.statusFilter}` : ''}{cfg.nameFilter.trim() && cfg.nameFilter.trim() !== '*' ? ` matching ${cfg.nameFilter.trim()}` : ''}</>
                )}
              </PlanRow>
              <PlanRow label="Account resources">{account ? <span className="text-ok">Included</span> : <span className="text-muted">Skipped</span>}</PlanRow>
              <PlanRow label="Mode">{cfg.importMode ? 'Generate + import' : 'Generate only'}</PlanRow>
              <PlanRow label="Audit logs">{cfg.auditLogHours}h</PlanRow>
              <PlanRow label="Offsite">
                <span className="flex justify-end gap-1.5">
                  {cfg.r2.enabled && <Badge tone="info" className="!text-cyan !border-cyan/25 !bg-cyan/10">R2</Badge>}
                  {cfg.aws.enabled && <Badge tone="info">S3</Badge>}
                  {!cfg.r2.enabled && !cfg.aws.enabled && <span className="text-muted">Local only</span>}
                </span>
              </PlanRow>
              <PlanRow label="Upload to R2">
                {cfg.r2.enabled ? <span className="font-mono text-[12px]">{bucketOf('r2') || 'choose an account set'}</span> : <span className="text-muted">Off</span>}
              </PlanRow>
              <PlanRow label="Upload to S3">
                {cfg.aws.enabled ? <span className="font-mono text-[12px]">{bucketOf('aws') || 'choose an account set'}</span> : <span className="text-muted">Off</span>}
              </PlanRow>
            </div>
            <div className="border-t border-line px-5 py-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="eyebrow">Equivalent command</span>
                <button onClick={async () => { await copyText(command); toast('Command copied (no secrets included)'); }} className="rounded p-1 text-faint hover:text-ink" title="Copy">
                  <Copy className="size-3.5" />
                </button>
              </div>
              <pre className="max-h-40 overflow-auto rounded-lg border border-line bg-canvas p-3 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-ink-2">
                <span className="text-faint">$ </span>{command}
              </pre>
            </div>
            {problems.length > 0 && (
              <div className="space-y-1.5 border-t border-line px-5 py-4">
                {problems.map((p) => (
                  <div key={p} className="flex gap-2 text-[12.5px] text-warn"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{p}</div>
                ))}
              </div>
            )}
            {request && (
              <div className="space-y-3 border-t border-line p-4 text-[13px]">
                {request.status === 'pending' ? (
                  <>
                    <div className="flex items-start gap-2.5"><span className="live-dot mt-1.5 size-2 shrink-0 rounded-full bg-live" />
                      <span><span className="font-medium text-ink">Waiting for an admin to approve</span><span className="block text-xs text-muted">Asked {relTime(request.requestedAt)} — the backup starts as soon as it is approved. <Link href="/approvals" className="text-signal hover:underline">Approvals</Link></span></span>
                    </div>
                    <Button variant="ghost" size="sm" className="w-full" loading={withdrawing} onClick={withdrawRequest}>Withdraw the request</Button>
                  </>
                ) : (
                  <>
                    <Alert tone={request.status === 'approved' ? 'ok' : request.status === 'withdrawn' ? 'info' : 'bad'}
                      title={request.status === 'approved' ? 'Approved' : request.status === 'rejected' ? `Rejected by ${request.decidedBy?.email}` : request.status === 'withdrawn' ? 'Withdrawn' : request.status === 'expired' ? 'Expired' : 'Could not start'}>
                      {request.reason ?? (request.status === 'approved' && request.runId ? <Link href={`/runs/${request.runId}`} className="text-signal hover:underline">Open the run</Link> : 'Change the configuration and ask again if needed.')}
                    </Alert>
                    <Button variant="ghost" size="sm" className="w-full" onClick={clearRequest}>Dismiss</Button>
                  </>
                )}
              </div>
            )}
            <div className="border-t border-line p-4">
              {needsApproval ? (
                <Button variant="primary" size="lg" className="w-full" disabled={problems.length > 0 || request?.status === 'pending'} loading={starting} icon={<Play className="size-4" />} onClick={start}>
                  Request backup
                </Button>
              ) : activeRun ? (
                <Link href={`/runs/${activeRun}`} className="flex h-11 items-center justify-center gap-2 rounded-[10px] border border-signal/30 bg-signal/10 text-sm font-medium text-signal">
                  <span className="live-dot size-2 rounded-full bg-live" /> A backup is running — view it
                </Link>
              ) : activeRestore ? (
                <Link href="/restore/new" className="flex h-11 items-center justify-center gap-2 rounded-[10px] border border-signal/30 bg-signal/10 text-sm font-medium text-signal">
                  <span className="live-dot size-2 rounded-full bg-live" /> A restore of {activeRestore.zone} is running — view it
                </Link>
              ) : (
                <Button variant="primary" size="lg" className="w-full" disabled={problems.length > 0} loading={starting} icon={<Play className="size-4" />} onClick={start}>
                  Start backup
                </Button>
              )}
            </div>
          </Card>
          {needsApproval && <p className="px-1 text-xs text-muted">Operator backups start once an admin or super admin approves them. Every request and decision is in the audit log.</p>}
          <div className="flex items-start gap-2.5 px-1 text-xs text-muted">
            {account ? <Globe2 className="mt-0.5 size-3.5 shrink-0" /> : <Cloud className="mt-0.5 size-3.5 shrink-0" />}
            <code className="font-mono">terraform</code> and <code className="font-mono">cf-terraforming</code> are downloaded and verified automatically if missing — no local install needed.
          </div>
        </aside>
      </div>

      <Modal
        open={saveOpen} onClose={() => setSaveOpen(false)} title="Save as preset"
        description="Stores these options (not the secrets — only which vault credential to use)."
        footer={<><Button variant="ghost" onClick={() => setSaveOpen(false)}>Cancel</Button><Button variant="primary" onClick={savePreset} disabled={!presetName.trim()}>Save preset</Button></>}
      >
        <Field label="Preset name" hint={presets.some((p) => p.name.toLowerCase() === presetName.trim().toLowerCase()) ? 'A preset with this name exists — it will be updated.' : undefined}>
          <input className="input" autoFocus value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="e.g. Nightly — full account" onKeyDown={(e) => { if (e.key === 'Enter' && presetName.trim()) savePreset(); }} />
        </Field>
      </Modal>
    </div>
  );
}

export default function BackupPage() {
  const { can } = useMe();
  if (!can('runs:start')) {
    return (
      <Card className="rise mx-auto mt-6 max-w-lg">
        <EmptyState icon={<Play className="size-5" />} title="Viewers cannot start backups"
          description="Your role can browse run history, live logs and backup files. Ask an admin for the Operator role to run backups." />
      </Card>
    );
  }
  return <Suspense><BackupBuilder /></Suspense>;
}
