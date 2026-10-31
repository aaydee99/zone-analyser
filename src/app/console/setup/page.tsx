'use client';

import { useCallback, useEffect, useState } from 'react';
import { BRAND } from '@/lib/brand';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Circle, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/client';
import { Alert, Button, cx } from '@/components/ui';
import { AuthFrame, PasswordStrength } from '@/components/auth-frame';
import { Captcha } from '@/components/captcha';

interface SetupState { configured: boolean; missing: string[]; needsSetup: boolean; schemaError: string | null; signupEnabled?: boolean | null; captchaSiteKey?: string | null }

const ENV_HELP: Record<string, string> = {
  SUPABASE_URL: 'Project Settings › API › Project URL',
  SUPABASE_ANON_KEY: 'Project Settings › API › anon / publishable key',
  SUPABASE_SERVICE_ROLE_KEY: 'Project Settings › API › service_role / secret key (server only)',
};

function Step({ done, title, children }: { done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      {done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-label="done" /> : <Circle className="mt-0.5 size-4 shrink-0 text-faint" aria-label="to do" />}
      <div className="min-w-0 flex-1">
        <div className={cx('text-[13.5px] font-medium', done ? 'text-muted' : 'text-ink')}>{title}</div>
        {!done && children && <div className="mt-1.5 text-[13px] text-muted">{children}</div>}
      </div>
    </li>
  );
}

export default function SetupPage() {
  const router = useRouter();
  const [state, setState] = useState<SetupState | null>(null);
  const [checking, setChecking] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '', token: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [captchaRound, setCaptchaRound] = useState(0);
  const onCaptcha = useCallback((t: string) => setCaptcha(t), []);

  const load = useCallback(async () => {
    setChecking(true);
    try {
      const s = await api<SetupState>('/api/setup');
      setState(s);
      if (s.configured && !s.needsSetup && !s.schemaError) router.replace('/console/login');
    } finally { setChecking(false); }
  }, [router]);
  useEffect(() => { load().catch(() => {}); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (form.password.length < 12) return setError('Use at least 12 characters.');
    if (form.password !== form.confirm) return setError('Passwords do not match.');
    setBusy(true);
    try {
      await api('/api/setup', { method: 'POST', json: { name: form.name, email: form.email, password: form.password, setupToken: form.token, captcha } });
      router.replace('/console');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
      setBusy(false);
      setCaptchaRound((n) => n + 1);
    }
  };

  const envOk = !!state?.configured;
  const schemaOk = envOk && !state?.schemaError;

  return (
    <AuthFrame wide title={`Set up ${BRAND.name}`} description="Connect Supabase, then create the first super admin. Everyone else is added from Users & roles.">
      <div className="panel space-y-5 p-6 shadow-pop">
        <ol className="space-y-4">
          <Step done={envOk} title="1 · Fill in .env.local">
            <p>Missing in <code className="font-mono text-ink-2">backup-console/.env.local</code>:</p>
            <ul className="mt-2 space-y-1.5">
              {state?.missing.map((k) => (
                <li key={k} className="rounded-lg border border-line bg-sunken px-3 py-2">
                  <code className="font-mono text-[12px] text-signal">{k}</code>
                  <div className="text-xs text-muted">{ENV_HELP[k]}</div>
                </li>
              ))}
            </ul>
            <p className="mt-2">Then restart the server (<code className="font-mono">npm start</code>).</p>
          </Step>
          <Step done={schemaOk} title="2 · Apply the database schema">
            <p>
              Run <code className="font-mono text-ink-2">0001_backup_console.sql</code> then <code className="font-mono text-ink-2">0002_hardening.sql</code> from
              {' '}<code className="font-mono text-ink-2">supabase/migrations/</code> in the Supabase SQL editor, in that order.
            </p>
            {state?.schemaError && <p className="mt-1.5 font-mono text-[11.5px] break-words text-bad">{state.schemaError}</p>}
          </Step>
          <Step done={state?.signupEnabled === false} title="3 · Turn off public sign-up in Supabase">
            <p>Authentication › Sign In / Providers › disable <span className="text-ink-2">Allow new users to sign up</span>. The console adds people itself; public sign-ups are never needed.</p>
            {state?.signupEnabled === null && <p className="mt-1 text-xs">Could not read the Supabase Auth settings — check it manually.</p>}
          </Step>
          <Step done={false} title="4 · Create the super admin" />
        </ol>

        {schemaOk ? (
          <form onSubmit={submit} className="space-y-4 border-t border-line pt-5">
            <Alert tone="info" title="The super admin is the only role that can open the credential vault">
              The vault gets its own, separate password — you set it the first time you open Credentials.
            </Alert>
            <div className="space-y-1.5">
              <label htmlFor="token" className="text-[13px] font-medium text-ink-2">Setup token</label>
              <input id="token" autoComplete="off" spellCheck={false} value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} className="input font-mono" required />
              <p className="text-xs text-muted">Printed in the terminal running the console, and saved to <code className="font-mono">data/setup-token.txt</code>. Proves you are at the server, not a web page.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="name" className="text-[13px] font-medium text-ink-2">Name</label>
                <input id="name" autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="email" className="text-[13px] font-medium text-ink-2">Email</label>
                <input id="email" type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="input" required />
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="pw" className="text-[13px] font-medium text-ink-2">Sign-in password</label>
              <input id="pw" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="input" required />
              <PasswordStrength value={form.password} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="pw2" className="text-[13px] font-medium text-ink-2">Confirm password</label>
              <input id="pw2" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} className="input" required />
            </div>
            <Captcha siteKey={state?.captchaSiteKey ?? null} onToken={onCaptcha} resetKey={captchaRound} />
            {error && <p role="alert" className="rounded-lg border border-bad/25 bg-bad/[0.06] px-3 py-2 text-[13px] text-bad">{error}</p>}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!!state?.captchaSiteKey && !captcha} icon={<ShieldCheck className="size-4" />}>Create super admin</Button>
          </form>
        ) : (
          <div className="flex justify-end border-t border-line pt-5">
            <Button onClick={() => load()} loading={checking} icon={<RefreshCw className="size-4" />}>Check again</Button>
          </div>
        )}
      </div>
    </AuthFrame>
  );
}
