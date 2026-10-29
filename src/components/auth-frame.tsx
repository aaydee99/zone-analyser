import type { ReactNode } from 'react';
import { DatabaseBackup, Lock } from 'lucide-react';

/** Centered card used by the sign-in and setup screens. */
export function AuthFrame({ title, description, children, footer, wide }: {
  title: string; description: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  return (
    <div className="grid-bg relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className={`rise relative w-full ${wide ? 'max-w-[560px]' : 'max-w-[420px]'}`}>
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-5 grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-signal-soft to-signal text-signal-ink shadow-[0_10px_30px_-10px_var(--color-signal)]">
            <DatabaseBackup className="size-7" strokeWidth={2.2} />
          </div>
          <div className="eyebrow mb-2">Backup Console · Cloudflare → Terraform</div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{title}</h1>
          <div className="mt-2 max-w-[400px] text-sm text-muted">{description}</div>
        </div>
        {children}
        <p className="mt-6 flex items-center justify-center gap-1.5 text-center font-mono text-[11px] leading-relaxed text-faint">
          {footer ?? <><Lock className="size-3" aria-hidden /> Accounts by Supabase Auth · roles enforced on the server</>}
        </p>
      </div>
    </div>
  );
}

export function PasswordStrength({ value }: { value: string }) {
  let s = 0;
  if (value.length >= 12) s++;
  if (value.length >= 16) s++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) s++;
  if (/\d/.test(value)) s++;
  if (/[^A-Za-z0-9]/.test(value)) s++;
  s = Math.min(4, s);
  const label = value.length < 12 ? 'Too short' : ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][s];
  if (!value) return null;
  return (
    <div className="flex items-center gap-2 pt-1">
      <div className="flex flex-1 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`h-1 flex-1 rounded-full ${i < s ? (s >= 3 ? 'bg-ok' : s === 2 ? 'bg-warn' : 'bg-bad') : 'bg-line-strong'}`} />
        ))}
      </div>
      <span className="w-16 text-right text-[11px] text-muted">{label}</span>
    </div>
  );
}
