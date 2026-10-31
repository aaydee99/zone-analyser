'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Eye, EyeOff, LogIn } from 'lucide-react';
import { api } from '@/lib/client';
import { Button } from '@/components/ui';
import { AuthFrame } from '@/components/auth-frame';
import { Captcha } from '@/components/captcha';

/**
 * Where to go after sign-in. Parsed the way the browser will parse it, so tricks
 * such as "/\evil.example" (read as "//evil.example") cannot leave this origin.
 */
function safeNext(next: string | null): string {
  if (!next || typeof window === 'undefined') return '/';
  try {
    const url = new URL(next, window.location.origin);
    if (url.origin !== window.location.origin) return '/';
    return `${url.pathname}${url.search}${url.hash}` || '/';
  } catch {
    return '/';
  }
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // CAPTCHA (Cloudflare Turnstile) when the server has it on; a token is single-use.
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState('');
  const [captchaRound, setCaptchaRound] = useState(0);
  const onCaptcha = useCallback((t: string) => setCaptcha(t), []);

  const target = safeNext(params.get('next'));

  // First run or missing configuration → setup screen.
  useEffect(() => {
    api<{ configured: boolean; needsSetup: boolean; schemaError: string | null; captchaSiteKey?: string | null }>('/api/setup')
      .then((s) => { setSiteKey(s.captchaSiteKey ?? null); if (!s.configured || s.needsSetup || s.schemaError) router.replace('/setup'); })
      .catch(() => {});
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/auth/login', { method: 'POST', json: { email, password: pw, captcha } });
      router.replace(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
      setBusy(false);
      setCaptchaRound((n) => n + 1);
    }
  };

  return (
    <AuthFrame title="Sign in to run backups" description="Export zones and account config to Terraform and JSON, with offsite copies to R2 or S3.">
      <form onSubmit={submit} className="panel space-y-4 p-6 shadow-pop">
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-[13px] font-medium text-ink-2">Email</label>
          <input id="email" type="email" autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className="input" disabled={busy} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="pw" className="text-[13px] font-medium text-ink-2">Password</label>
          <div className="relative">
            <input id="pw" type={show ? 'text' : 'password'} autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} className="input !pr-10" disabled={busy} />
            <button type="button" onClick={() => setShow((v) => !v)} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted hover:text-ink" aria-label={show ? 'Hide password' : 'Show password'}>
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>
        <Captcha siteKey={siteKey} onToken={onCaptcha} resetKey={captchaRound} />
        {error && <p role="alert" className="rounded-lg border border-bad/25 bg-bad/[0.06] px-3 py-2 text-[13px] text-bad">{error}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!email || !pw || (!!siteKey && !captcha)} icon={<LogIn className="size-4" />}>
          Sign in
        </Button>
        <p className="text-center text-xs text-muted">No account? Ask an admin to add you under Users &amp; roles.</p>
      </form>
    </AuthFrame>
  );
}

export default function LoginPage() {
  return <Suspense><LoginInner /></Suspense>;
}
