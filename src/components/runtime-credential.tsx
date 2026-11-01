'use client';

import { Field, Segmented } from './ui';

// The Cloudflare credential a change runs with, typed in at the moment it runs (Logpush job
// management, cache purges): an API token with the change's permission, or a Global API Key and its
// email. Kept in the dialog's state only, sent with that one request, never saved; the dialog
// clears it when it closes.

export type RuntimeCredentialInput = { kind: 'token' | 'global'; token: string; email: string; apiKey: string };
export const EMPTY_CREDENTIAL: RuntimeCredentialInput = { kind: 'token', token: '', email: '', apiKey: '' };

/** The request body's `cloudflare` field. */
export const credentialBody = (c: RuntimeCredentialInput) => (c.kind === 'token' ? { kind: 'token', token: c.token.trim() } : { kind: 'global', email: c.email.trim(), apiKey: c.apiKey.trim() });
export const credentialReady = (c: RuntimeCredentialInput) => (c.kind === 'token' ? c.token.trim().length >= 30 : /\S+@\S+\.\S+/.test(c.email) && c.apiKey.trim().length >= 30);

export function RuntimeCredentialFields({ value, onChange, scope, purpose = 'logpush', disabled }: { value: RuntimeCredentialInput; onChange: (c: RuntimeCredentialInput) => void; scope?: 'account' | 'zone'; purpose?: 'logpush' | 'purge'; disabled?: boolean }) {
  const where = scope === 'zone' ? 'Zone' : scope === 'account' ? 'Account' : 'Account or Zone';
  const purge = purpose === 'purge';
  return (
    <fieldset className="space-y-3 rounded-xl border border-line px-4 py-3" disabled={disabled}>
      <legend className="px-1 text-[13px] font-medium text-ink-2">Cloudflare credential for this {purge ? 'purge' : 'change'}</legend>
      <p className="text-xs text-muted">Stored tokens are never used to {purge ? 'purge the cache' : 'change Logpush'}. What you enter is sent with this request only and is not saved or logged.</p>
      <Segmented value={value.kind} onChange={(kind) => onChange({ ...value, kind })}
        options={[{ value: 'token', label: 'API token', hint: purge ? 'Zone › Cache Purge › Purge' : `${where} › Logs › Edit` }, { value: 'global', label: 'Global API Key', hint: 'With the account email' }]} />
      {value.kind === 'token' ? (
        <Field label="API token">
          <input type="password" autoComplete="off" spellCheck={false} className="input font-mono" value={value.token} onChange={(e) => onChange({ ...value, token: e.target.value })} />
        </Field>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cloudflare account email">
            <input type="email" autoComplete="off" className="input" value={value.email} onChange={(e) => onChange({ ...value, email: e.target.value })} />
          </Field>
          <Field label="Global API Key">
            <input type="password" autoComplete="off" spellCheck={false} className="input font-mono" value={value.apiKey} onChange={(e) => onChange({ ...value, apiKey: e.target.value })} />
          </Field>
        </div>
      )}
    </fieldset>
  );
}
