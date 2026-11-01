'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2, Cloud, Copy, Eye, EyeOff, FileUp, KeyRound, Lock, Pencil, Plus, Search, ShieldCheck, Trash2, Wifi, XCircle, Archive, Database, ArrowRightLeft,
} from 'lucide-react';
import { api, ApiError, copyText, relTime } from '@/lib/client';
import { KIND_ORDER, KINDS, STORAGE_LABEL, groupKey, type CredentialKind, type CredentialSummary, type FieldDef, type StorageKind } from '@/lib/kinds';
import { Badge, Button, Card, EmptyState, Field, Loading, Modal, PageHeader, Skeleton, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useMe } from '@/components/me';
import { PasswordStrength } from '@/components/auth-frame';

const KIND_ICON: Record<CredentialKind, typeof Cloud> = { cloudflare: Cloud, r2: Archive, aws: Database };
const KIND_TINT: Record<CredentialKind, string> = {
  cloudflare: 'text-signal bg-signal/10 border-signal/25',
  r2: 'text-cyan bg-cyan/10 border-cyan/25',
  aws: 'text-info bg-info/10 border-info/25',
};

function SecretValue({ cred, field }: { cred: CredentialSummary; field: string }) {
  const toast = useToast();
  const [value, setValue] = useState<string | null>(null);
  const view = cred.fields[field];
  const def = KINDS[cred.kind].fields.find((f) => f.key === field)!;

  // Hide again after 20s so plaintext does not linger on screen.
  useEffect(() => {
    if (value === null) return;
    const t = setTimeout(() => setValue(null), 20_000);
    return () => clearTimeout(t);
  }, [value]);

  const fetchValue = () => api<{ value: string }>(`/api/credentials/${cred.id}/reveal`, { method: 'POST', json: { field } }).then((r) => r.value);

  if (!view?.set) {
    // No account ID: the account set covers every account its token can access.
    if (cred.kind === 'cloudflare' && field === 'accountId') return <span className="text-[12.5px] text-ink-2">All accounts the token can access</span>;
    return <span className="text-faint">—</span>;
  }
  if (!def.secret) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-[12.5px] text-ink-2">{view.value}</span>
        <button onClick={async () => { await copyText(view.value ?? ''); toast(`${def.label} copied`); }} className="shrink-0 rounded p-1 text-faint hover:text-ink" title="Copy">
          <Copy className="size-3.5" />
        </button>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate font-mono text-[12.5px] text-ink-2">{value ?? `••••••••${view.hint?.replace('…', '') ?? ''}`}</span>
      <button
        onClick={async () => { try { setValue(value === null ? await fetchValue() : null); } catch (e) { toast((e as Error).message, 'bad'); } }}
        className="shrink-0 rounded p-1 text-faint hover:text-ink" title={value === null ? 'Reveal' : 'Hide'}
      >
        {value === null ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </button>
      <button
        onClick={async () => {
          try { await copyText(value ?? await fetchValue()); toast(`${def.label} copied — clipboard clears in 30s`); setTimeout(() => copyText('').catch(() => {}), 30_000); } catch (e) { toast((e as Error).message, 'bad'); }
        }}
        className="shrink-0 rounded p-1 text-faint hover:text-ink" title="Copy"
      >
        <Copy className="size-3.5" />
      </button>
    </span>
  );
}

/** Lists the buckets the typed (or stored) keys can see; clicking one adds it to / removes it from the approved list. */
function BucketFinder({ kind, id, fields, defaultBucket, value, onChange }: {
  kind: StorageKind; id?: string; fields: Record<string, string>; defaultBucket: string; value: string; onChange: (v: string) => void;
}) {
  const [found, setFound] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const listed = value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const toggle = (b: string) => onChange((listed.includes(b) ? listed.filter((x) => x !== b) : [...listed, b]).join('\n'));
  const find = async () => {
    setBusy(true);
    setError('');
    try {
      setFound((await api<{ buckets: string[] }>('/api/credentials/buckets', { method: 'POST', json: { kind, id, fields } })).buckets);
    } catch (e) { setError((e as Error).message); setFound(null); } finally { setBusy(false); }
  };
  return (
    <div className="mt-2 space-y-2">
      <Button type="button" size="sm" icon={<Search className="size-3.5" />} loading={busy} onClick={find}>Find buckets</Button>
      {error && <p className="text-xs text-bad">{error}</p>}
      {found && (found.length ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Buckets these keys can see">
          {found.map((b) => {
            const isDefault = b === defaultBucket.trim();
            const on = isDefault || listed.includes(b);
            return (
              <button key={b} type="button" disabled={isDefault} onClick={() => toggle(b)} aria-pressed={on}
                className={cx('rounded-md border px-2 py-1 font-mono text-[12px] transition-colors', on ? 'border-signal/50 bg-signal/10 text-ink' : 'border-line text-muted hover:border-line-strong hover:text-ink-2', isDefault && 'cursor-default opacity-80')}>
                {on ? '✓ ' : '+ '}{b}{isDefault ? ' (default)' : ''}
              </button>
            );
          })}
        </div>
      ) : <p className="text-xs text-muted">These keys can’t see any buckets.</p>)}
    </div>
  );
}

/** Fields in display order: the main ones, then each optional storage section. */
function sections(defs: FieldDef[]): { group?: StorageKind; defs: FieldDef[] }[] {
  const out: { group?: StorageKind; defs: FieldDef[] }[] = [];
  for (const d of defs) {
    const last = out[out.length - 1];
    if (last && last.group === d.group) last.defs.push(d);
    else out.push({ group: d.group, defs: [d] });
  }
  return out;
}

function CredentialEditor({ open, onClose, initial, onSaved }: {
  open: boolean; onClose: () => void; initial: CredentialSummary | null; onSaved: (c: CredentialSummary) => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<CredentialKind>('cloudflare');
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Storage sections of an account set the user removed in this edit. */
  const [cleared, setCleared] = useState<Partial<Record<StorageKind, boolean>>>({});

  useEffect(() => {
    if (!open) return;
    setCleared({});
    setKind(initial?.kind ?? 'cloudflare');
    setName(initial?.name ?? '');
    setNotes(initial?.notes ?? '');
    const f: Record<string, string> = {};
    if (initial) for (const [k, v] of Object.entries(initial.fields)) if (v.value) f[k] = v.value;
    setFields(f);
    setShow({});
    setError('');
  }, [open, initial]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { name, notes, kind, fields: { ...fields, ...(cleared.r2 ? { r2Clear: '1' } : {}), ...(cleared.aws ? { awsClear: '1' } : {}) } };
      const res = initial
        ? await api<{ credential: CredentialSummary }>(`/api/credentials/${initial.id}`, { method: 'PUT', json: body })
        : await api<{ credential: CredentialSummary }>('/api/credentials', { method: 'POST', json: body });
      toast(initial ? 'Saved' : 'Account set stored in the vault');
      onSaved(res.credential);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open} onClose={onClose} width="max-w-xl"
      title={initial ? `Edit ${initial.name}` : 'Add account set'}
      description="Values are encrypted on the server before they are stored in Supabase."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="cred-form" loading={busy}>{initial ? 'Save changes' : 'Store account set'}</Button>
      </>}
    >
      <form id="cred-form" onSubmit={save} className="space-y-5">
        <p className="text-[13px] text-muted">{KINDS[kind].description}</p>

        <Field label="Name" htmlFor="c-name">
          <input id="c-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'cloudflare' ? 'e.g. Production account' : 'e.g. Backup bucket'} autoFocus />
        </Field>

        {sections(KINDS[kind].fields).map(({ group, defs }) => {
          const had = !!group && !!initial?.fields[groupKey(group, 'accessKeyId')]?.set;
          const gone = !!group && !!cleared[group];
          return (
            <div key={group ?? 'main'} className={cx(group && 'space-y-5 rounded-xl border border-line px-4 py-4')}>
              {group && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[13px] font-semibold">{STORAGE_LABEL[group]} <span className="font-normal text-faint">· optional</span></p>
                    <p className="text-xs text-muted">{gone ? `Will be removed from this set when you save.` : `Leave it all empty if this account's backups don't go to ${STORAGE_LABEL[group]}.`}</p>
                  </div>
                  {had && (
                    <Button type="button" size="sm" variant="ghost" className={gone ? '' : 'hover:!text-bad'} onClick={() => setCleared((c) => ({ ...c, [group]: !c[group] }))}>
                      {gone ? 'Keep it' : `Remove ${STORAGE_LABEL[group]}`}
                    </Button>
                  )}
                </div>
              )}
              {!gone && defs.map((f) => {
          const existing = initial?.fields[f.key];
          const hidden = f.secret && !show[f.key];
          return (
            <Field
              key={f.key} label={f.label} htmlFor={`c-${f.key}`} optional={!f.required || !!f.group}
              hint={f.secret && existing?.set ? `Stored (${existing.hint}). Leave blank to keep it.` : f.help}
            >
              {f.multiline ? (
                <>
                  <textarea
                    id={`c-${f.key}`} className={cx('input font-mono !text-[12.5px]', f.list ? 'min-h-[84px]' : 'min-h-[110px]')} spellCheck={false}
                    value={fields[f.key] ?? ''} placeholder={f.placeholder}
                    onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
                  />
                  {f.list && (f.group || kind === 'r2' || kind === 'aws') && (
                    <BucketFinder
                      kind={f.group ?? (kind as StorageKind)} id={initial?.id} fields={fields}
                      defaultBucket={fields[f.group ? groupKey(f.group, 'bucket') : 'bucket'] ?? ''}
                      value={fields[f.key] ?? ''} onChange={(v) => setFields((s) => ({ ...s, [f.key]: v }))}
                    />
                  )}
                </>
              ) : (
              <div className="relative">
                <input
                  id={`c-${f.key}`}
                  className={cx('input font-mono', f.secret && '!pr-10')}
                  type={hidden ? 'password' : 'text'}
                  autoComplete="off" spellCheck={false}
                  value={fields[f.key] ?? ''}
                  placeholder={f.secret && existing?.set ? '•••••••• unchanged' : f.placeholder}
                  onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
                />
                {f.secret && (
                  <button type="button" onClick={() => setShow((s) => ({ ...s, [f.key]: !s[f.key] }))} aria-label={hidden ? 'Show value' : 'Hide value'} aria-pressed={!hidden} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted hover:text-ink">
                    {hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                  </button>
                )}
              </div>
              )}
            </Field>
          );
              })}
            </div>
          );
        })}

        <Field label="Notes" htmlFor="c-notes" optional>
          <textarea id="c-notes" className="input min-h-[64px] resize-y" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Scope, owner, rotation date…" />
        </Field>
        {error && <p className="rounded-lg border border-bad/25 bg-bad/[0.06] px-3 py-2 text-[13px] text-bad">{error}</p>}
      </form>
    </Modal>
  );
}

function VaultContents({ onLocked, header }: { onLocked: () => void; header: React.ReactNode }) {
  const toast = useToast();
  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 423) onLocked();
    else toast((e as Error).message, 'bad');
  }, [onLocked, toast]);
  const [creds, setCreds] = useState<CredentialSummary[] | null>(null);
  const [editing, setEditing] = useState<CredentialSummary | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleting, setDeleting] = useState<CredentialSummary | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [filter, setFilter] = useState<CredentialKind | 'all'>('all');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);
  const [moving, setMoving] = useState<CredentialSummary | null>(null);
  const [moveTo, setMoveTo] = useState('');
  const [moveDelete, setMoveDelete] = useState(true);
  const [moveBusy, setMoveBusy] = useState(false);
  /** Account sets a legacy R2 / AWS entry can move into (those without that storage yet). */
  const targetsFor = (c: CredentialSummary) => (creds ?? []).filter((x) => x.kind === 'cloudflare' && !x.fields[groupKey(c.kind as StorageKind, 'accessKeyId')]?.set);
  const runMove = async () => {
    if (!moving || !moveTo) return;
    setMoveBusy(true);
    try {
      await api(`/api/credentials/${moveTo}/attach`, { method: 'POST', json: { from: moving.id, removeSource: moveDelete } });
      toast(`${moving.name} moved into the account set`);
      setMoving(null);
      load();
    } catch (e) { fail(e); } finally { setMoveBusy(false); }
  };

  const runImport = async () => {
    setImporting(true);
    try {
      const r = await api<{ created: CredentialSummary[]; skipped: string[] }>('/api/credentials/import', { method: 'POST', json: { text: importText, name: importName } });
      toast(r.created.length ? `Imported account set “${r.created[0].name}”` : `Nothing imported${r.skipped.length ? ` · ${r.skipped.join('; ')}` : ''}`, r.created.length ? 'ok' : 'info');
      setImportText('');
      setImportOpen(false);
      load();
    } catch (e) {
      fail(e);
    } finally {
      setImporting(false);
    }
  };

  const load = useCallback(() => api<{ credentials: CredentialSummary[] }>('/api/credentials').then((r) => setCreds(r.credentials)), []);
  useEffect(() => { load().catch(fail); }, [load, fail]);

  const shown = useMemo(() => (creds ?? []).filter((c) => filter === 'all' || c.kind === filter), [creds, filter]);

  const test = async (c: CredentialSummary) => {
    setTesting(c.id);
    try {
      const { result } = await api<{ result: { ok: boolean; message: string } }>(`/api/credentials/${c.id}/test`, { method: 'POST' });
      toast(result.message, result.ok ? 'ok' : 'bad');
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setTesting(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await api(`/api/credentials/${deleting.id}`, { method: 'DELETE' });
      toast('Credential deleted');
      setDeleting(null);
      load();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Configuration"
        title="Credentials"
        description="Account sets: each is one Cloudflare account together with its own R2 and/or S3 storage, so a backup can only go to its own account's buckets. Super admin only. Other roles pick a set by name — they never see a value."
        actions={<>
          <Button icon={<FileUp className="size-4" />} onClick={() => setImportOpen(true)}>Import .env</Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => { setEditing(null); setEditorOpen(true); }}>Add account set</Button>
        </>}
      />
      {header}

      <div className="mb-4 flex flex-wrap gap-1.5">
        {(['all', ...KIND_ORDER] as const).map((k) => {
          const n = k === 'all' ? creds?.length ?? 0 : creds?.filter((c) => c.kind === k).length ?? 0;
          if (k !== 'all' && KINDS[k].legacy && !n) return null; // legacy filters only while some exist
          return (
            <button key={k} onClick={() => setFilter(k)} className={cx('rounded-lg border px-3 py-1.5 text-[13px] transition-colors', filter === k ? 'border-line-strong bg-raised text-ink' : 'border-transparent text-muted hover:text-ink-2')}>
              {k === 'all' ? 'All' : KINDS[k].short} {creds ? <span className="ml-1 font-mono text-[11px] text-faint">{n}</span> : <Skeleton className="ml-1 !inline-block h-2.5 w-3 align-middle" />}
            </button>
          );
        })}
      </div>

      {!creds ? (
        <Loading label="Loading credentials" className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <Card key={i} className="flex flex-col">
              <div className="flex items-start gap-3 border-b border-line px-5 py-4">
                <Skeleton className="size-9 shrink-0 rounded-lg" />
                <div className="flex-1 space-y-2 pt-0.5"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-28" /></div>
              </div>
              <div className="flex-1 space-y-3 px-5 py-4">
                {[0, 1, 2, 3].map((j) => <div key={j} className="grid grid-cols-[130px_1fr] items-center gap-3"><Skeleton className="h-3 w-20" /><Skeleton className="h-3 w-3/4" /></div>)}
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3"><Skeleton className="h-3 w-24" /><Skeleton className="h-6 w-32" /></div>
            </Card>
          ))}
        </Loading>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={<KeyRound className="size-5" />}
            title={creds.length ? 'Nothing of this type' : 'Your vault is empty'}
            description="Add an account set: a Cloudflare API token and account ID — that's all a backup needs — plus the R2 and/or S3 storage its backups go to."
            action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => { setEditing(null); setEditorOpen(true); }}>Add account set</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {shown.map((c) => {
            const Icon = KIND_ICON[c.kind];
            return (
              <Card key={c.id} className="flex flex-col">
                <div className="flex items-start gap-3 border-b border-line px-5 py-4">
                  <div className={cx('grid size-9 shrink-0 place-items-center rounded-lg border', KIND_TINT[c.kind])}><Icon className="size-[18px]" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-[15px] font-semibold">{c.name}</h3>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">{KINDS[c.kind].label}</div>
                  </div>
                  {c.lastTest && (
                    <Badge tone={c.lastTest.ok ? 'ok' : 'bad'}>
                      {c.lastTest.ok ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
                      {c.lastTest.ok ? 'Verified' : 'Failing'}
                    </Badge>
                  )}
                </div>
                <dl className="flex-1 space-y-2.5 px-5 py-4">
                  {sections(KINDS[c.kind].fields).map(({ group, defs }) => {
                    if (group && !c.fields[groupKey(group, 'accessKeyId')]?.set) {
                      return <p key={group} className="border-t border-line pt-2.5 text-[13px] text-faint">{STORAGE_LABEL[group]}: not set</p>;
                    }
                    return (
                      <div key={group ?? 'main'} className={cx('space-y-2.5', group && 'border-t border-line pt-2.5')}>
                        {group && <p className="text-xs font-semibold tracking-wide text-muted uppercase">{STORAGE_LABEL[group]}</p>}
                        {defs.filter((f) => !group || c.fields[f.key]?.set).map((f) => (
                          <div key={f.key} className="grid grid-cols-[130px_1fr] items-center gap-3 text-[13px]">
                            <dt className="text-muted">{f.label}</dt>
                            <dd className="min-w-0"><SecretValue cred={c} field={f.key} /></dd>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                  {KINDS[c.kind].legacy && <p className="rounded-lg border border-warn/30 bg-warn/[0.06] px-3 py-2 text-xs text-ink-2">{KINDS[c.kind].description}</p>}
                  {c.notes && <p className="border-t border-line pt-3 text-[13px] text-muted">{c.notes}</p>}
                  {c.lastTest && <p className={cx('text-xs', c.lastTest.ok ? 'text-muted' : 'text-bad')}>{c.lastTest.message} · {relTime(c.lastTest.at)}</p>}
                </dl>
                <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
                  <span className="text-xs text-faint">{c.lastUsedAt ? `Used ${relTime(c.lastUsedAt)}` : `Added ${relTime(c.createdAt)}`}</span>
                  <div className="flex gap-1">
                    {KINDS[c.kind].legacy && (
                      <Button size="sm" variant="ghost" icon={<ArrowRightLeft className="size-3.5" />} onClick={() => { setMoving(c); setMoveTo(targetsFor(c)[0]?.id ?? ''); setMoveDelete(true); }}>Move into a set</Button>
                    )}
                    <Button size="sm" variant="ghost" loading={testing === c.id} icon={<Wifi className="size-3.5" />} onClick={() => test(c)}>Test</Button>
                    <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => { setEditing(c); setEditorOpen(true); }}>Edit</Button>
                    <Button size="sm" variant="ghost" className="hover:!text-bad" icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(c)} aria-label="Delete" />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        open={importOpen} onClose={() => setImportOpen(false)} width="max-w-2xl"
        title="Import from .env"
        description="Paste a backup.js .env file. It becomes one account set: CF_API_TOKEN and CF_ACCOUNT_ID (optional: without it, every account the token can access), with the R2 and AWS keys in it if the file has them. Nothing is written to disk unencrypted."
        footer={<>
          <Button variant="ghost" onClick={() => setImportOpen(false)}>Cancel</Button>
          <Button variant="primary" loading={importing} disabled={!importText.trim()} onClick={runImport} icon={<FileUp className="size-4" />}>Import</Button>
        </>}
      >
        <div className="space-y-4">
          <Field label="Name" hint="The account set's name.">
            <input className="input" value={importName} onChange={(e) => setImportName(e.target.value)} placeholder="e.g. Whitecap" />
          </Field>
          <Field label=".env contents">
            <textarea className="input min-h-[220px] font-mono !text-[12px]" spellCheck={false} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={'CF_API_TOKEN=...\nCF_ACCOUNT_ID=...\nR2_ACCESS_KEY_ID=...'} />
          </Field>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded text-[13px] text-signal hover:underline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring">
            <input type="file" accept=".env,text/plain" className="sr-only" onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              // Only small plain-text .env files (the server checks again).
              if (f.size > 64 * 1024) { toast('That file is too large for a .env file (64 KB at most)', 'bad'); return; }
              if (f.type && f.type !== 'text/plain' && !/\.env$|^\.env/i.test(f.name)) { toast('Choose a plain-text .env file', 'bad'); return; }
              const text = await f.text();
              if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) { toast('That is not a text .env file', 'bad'); return; }
              setImportText(text);
            }} />
            <FileUp className="size-3.5" /> or choose a file…
          </label>
        </div>
      </Modal>

      <CredentialEditor open={editorOpen} onClose={() => setEditorOpen(false)} initial={editing} onSaved={() => load()} />

      <Modal
        open={!!moving} onClose={() => setMoving(null)} title={moving ? `Move “${moving.name}” into an account set` : ''}
        description="Its keys are copied into the set on the server — nothing is shown or retyped. From then on only that account's backups can use them."
        footer={<>
          <Button variant="ghost" onClick={() => setMoving(null)}>Cancel</Button>
          <Button variant="primary" loading={moveBusy} disabled={!moveTo} onClick={runMove} icon={<ArrowRightLeft className="size-4" />}>Move</Button>
        </>}
      >
        {moving && (targetsFor(moving).length ? (
          <div className="space-y-4">
            <Field label="Account set">
              <select className="input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                {targetsFor(moving).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </Field>
            <label className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" checked={moveDelete} onChange={(e) => setMoveDelete(e.target.checked)} /> Delete this separate entry afterwards</label>
          </div>
        ) : <p className="text-sm text-muted">Every account set already has {STORAGE_LABEL[moving.kind as StorageKind]}. Remove it from one first, or add a new account set.</p>)}
      </Modal>

      <Modal
        open={!!deleting} onClose={() => setDeleting(null)} title="Delete credential?"
        description={deleting ? `"${deleting.name}" will be permanently removed from the vault.` : ''}
        footer={<><Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button><Button variant="danger" onClick={remove} icon={<Trash2 className="size-4" />}>Delete</Button></>}
      >
        <p className="text-sm text-muted">Presets that reference it will need a new credential before they can run. The key itself is not revoked at Cloudflare or AWS.</p>
      </Modal>
    </div>
  );
}

// ── Vault gate: super admin + separate vault password ───────────────────────

interface VaultStatus { initialized: boolean; passwordReset?: boolean; unlocked: boolean; expiresAt: number | null }

function VaultGate({ status, onDone }: { status: VaultStatus; onDone: () => void }) {
  const toast = useToast();
  // A new vault, or a new password after the vault password was reset in the database.
  const reset = !!status.initialized && !!status.passwordReset;
  const create = !status.initialized || reset;
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (create && pw.length < 12) return setError('Use at least 12 characters.');
    if (create && pw !== pw2) return setError('Passwords do not match.');
    setBusy(true);
    try {
      await api(create ? '/api/vault/init' : '/api/vault/unlock', { method: 'POST', json: { password: pw } });
      if (create) toast(reset ? 'New vault password set: stored credentials are unchanged' : 'Vault created');
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="rise mx-auto max-w-[460px] pt-6">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-4 grid size-12 place-items-center rounded-2xl border border-signal/30 bg-signal/10 text-signal">
          {create ? <ShieldCheck className="size-6" /> : <Lock className="size-6" />}
        </div>
        <div className="eyebrow mb-1.5">Super admin · Credentials</div>
        <h1 className="text-[22px] font-semibold">{reset ? 'Set a new vault password' : create ? 'Create the credential vault' : 'Vault locked'}</h1>
        <p className="mt-2 text-sm text-muted">
          {reset
            ? 'The vault password was reset. Choose a new one, different from your sign-in password. Every stored credential stays as it is.'
            : create
            ? 'Choose a vault password that is different from your sign-in password. It is needed every time you open the vault and cannot be recovered.'
            : 'Enter the vault password to view or change stored credentials. Backups keep running while it is locked.'}
        </p>
      </div>
      <form onSubmit={submit} className="panel space-y-4 p-6">
        <Field label={reset ? 'New vault password' : 'Vault password'} htmlFor="vpw">
          <input id="vpw" type="password" autoFocus autoComplete={create ? 'new-password' : 'off'} className="input font-mono" value={pw} onChange={(e) => setPw(e.target.value)} disabled={busy} />
          {create && <PasswordStrength value={pw} />}
        </Field>
        {create && (
          <Field label="Confirm vault password" htmlFor="vpw2">
            <input id="vpw2" type="password" autoComplete="new-password" className="input font-mono" value={pw2} onChange={(e) => setPw2(e.target.value)} disabled={busy} />
          </Field>
        )}
        {error && <p role="alert" className="rounded-lg border border-bad/25 bg-bad/[0.06] px-3 py-2 text-[13px] text-bad">{error}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!pw} icon={create ? <ShieldCheck className="size-4" /> : <KeyRound className="size-4" />}>
          {reset ? 'Set new password' : create ? 'Create vault' : 'Unlock vault'}
        </Button>
      </form>
    </div>
  );
}

function ChangeVaultPassword({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    if (f.next.length < 12) return setError('Use at least 12 characters.');
    if (f.next !== f.confirm) return setError('Passwords do not match.');
    setBusy(true);
    try {
      await api('/api/vault/password', { method: 'POST', json: { current: f.current, next: f.next } });
      toast('Vault password changed');
      setF({ current: '', next: '', confirm: '' });
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Change vault password" description="Only the password wrapping changes; stored credentials are not re-entered."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Change password</Button></>}>
      <div className="space-y-4">
        <Field label="Current vault password" htmlFor="cv1"><input id="cv1" type="password" className="input font-mono" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
        <Field label="New vault password" htmlFor="cv2">
          <input id="cv2" type="password" autoComplete="new-password" className="input font-mono" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
          <PasswordStrength value={f.next} />
        </Field>
        <Field label="Confirm new password" htmlFor="cv3"><input id="cv3" type="password" autoComplete="new-password" className="input font-mono" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
        {error && <p role="alert" className="rounded-lg border border-bad/25 bg-bad/[0.06] px-3 py-2 text-[13px] text-bad">{error}</p>}
      </div>
    </Modal>
  );
}

export default function VaultPage() {
  const { can } = useMe();
  const allowed = can('vault:access');
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pwOpen, setPwOpen] = useState(false);

  const load = useCallback(() => api<VaultStatus>('/api/vault/status').then(setStatus).catch(() => {}), []);
  useEffect(() => { if (allowed) load(); }, [allowed, load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // Auto-lock: the server forgets the key after the idle window; mirror it here.
  useEffect(() => {
    if (status?.unlocked && status.expiresAt && now > status.expiresAt) setStatus({ ...status, unlocked: false, expiresAt: null });
  }, [now, status]);

  if (!allowed) {
    return (
      <Card className="rise mx-auto mt-6 max-w-lg">
        <EmptyState icon={<Lock className="size-5" />} title="Super admin only"
          description="The credential vault is restricted to super admins. You can still start backups and use presets — credentials are applied on the server without being shown." />
      </Card>
    );
  }
  if (!status) {
    return (
      <Loading label="Checking the vault" className="space-y-3">
        <Skeleton className="h-3 w-24" /><Skeleton className="h-8 w-56" /><Skeleton className="h-3 w-[32rem] max-w-full" />
        <Skeleton className="!mt-8 h-40 w-full max-w-lg rounded-xl" />
      </Loading>
    );
  }
  if (!status.unlocked) return <VaultGate status={status} onDone={load} />;

  const lock = async () => { await api('/api/vault/lock', { method: 'POST' }).catch(() => {}); load(); };
  const left = status.expiresAt ? Math.max(0, status.expiresAt - now) : 0;
  const header = (
    <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-signal/25 bg-signal/[0.06] px-4 py-2.5 text-[13px]">
      <ShieldCheck className="size-4 text-signal" aria-hidden />
      <span className="flex-1 text-ink-2">
        Vault unlocked for this session · locks after {Math.floor(left / 60000)}:{String(Math.floor((left % 60000) / 1000)).padStart(2, '0')} idle
      </span>
      <Button size="sm" variant="ghost" onClick={() => setPwOpen(true)}>Change vault password</Button>
      <Button size="sm" icon={<Lock className="size-3.5" />} onClick={lock}>Lock vault</Button>
    </div>
  );
  return (
    <>
      <VaultContents onLocked={load} header={header} />
      <ChangeVaultPassword open={pwOpen} onClose={() => setPwOpen(false)} />
    </>
  );
}
