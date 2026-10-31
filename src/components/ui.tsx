'use client';

import { useEffect, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, X } from 'lucide-react';
import type { RunStatus } from '@/lib/run-types';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ── Button ──────────────────────────────────────────────────────────────────
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'btn-gold font-semibold',
  secondary: 'bg-raised text-ink border border-line-strong hover:border-faint hover:bg-raised-2',
  ghost: 'text-ink-2 hover:text-ink hover:bg-raised',
  danger: 'bg-bad/10 text-bad border border-bad/30 hover:bg-bad/20',
};

export function Button({
  variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-[10px] font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-200 select-none',
        'disabled:opacity-50 disabled:cursor-not-allowed active:translate-y-px',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-9 px-4 text-sm',
        size === 'lg' && 'h-11 px-5 text-[15px]',
        VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

// ── Layout primitives ───────────────────────────────────────────────────────
export function Card({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('panel', className)}>{children}</div>;
}

export function SectionHeader({ step, title, description, aside }: { step?: string; title: string; description?: string; aside?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div className="flex items-start gap-3">
        {step && (
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border border-line-strong bg-raised font-mono text-[11px] text-ink-2">
            {step}
          </span>
        )}
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
        </div>
      </div>
      {aside}
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <div className="eyebrow mb-2">{eyebrow}</div>}
        <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// ── Form controls ───────────────────────────────────────────────────────────
export function Field({ label, hint, error, children, htmlFor, optional }: {
  label: string; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string; optional?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
        {label}
        {optional && <span className="text-[11px] font-normal text-faint">optional</span>}
      </label>
      {children}
      {error ? <p className="text-xs text-bad">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function CheckboxBox({ checked, indeterminate }: { checked: boolean; indeterminate?: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        'grid size-[18px] shrink-0 place-items-center rounded-[5px] border transition-all duration-150',
        checked || indeterminate ? 'border-signal bg-signal text-signal-ink' : 'border-line-strong bg-sunken group-hover:border-faint',
      )}
    >
      {indeterminate ? <span className="h-0.5 w-2 rounded bg-current" /> : checked ? <Check className="size-3.5" strokeWidth={3} /> : null}
    </span>
  );
}

/** A CLI flag rendered as a checkable card: title, explanation, and the flag it maps to. */
export function FlagCard({ checked, onChange, title, description, flag, disabled, note }: {
  checked: boolean; onChange: (v: boolean) => void; title: string; description: ReactNode; flag?: string; disabled?: boolean; note?: ReactNode;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cx(
        'group relative flex cursor-pointer gap-3 rounded-xl border p-4 transition-all duration-150',
        checked ? 'border-signal/50 bg-signal/[0.06]' : 'border-line bg-sunken/60 hover:border-line-strong',
        disabled && 'pointer-events-none opacity-45',
      )}
    >
      <input id={id} type="checkbox" className="sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="pt-0.5"><CheckboxBox checked={checked} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">{title}</span>
          {flag && <code className="rounded-md border border-line bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-signal">{flag}</code>}
        </span>
        <span className="mt-1 block text-[13px] leading-relaxed text-muted">{description}</span>
        {note && <span className="mt-2 block text-xs text-ink-2">{note}</span>}
      </span>
    </label>
  );
}

export function Checkbox({ checked, onChange, label, disabled, indeterminate }: {
  checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; indeterminate?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={cx('group inline-flex cursor-pointer items-center gap-2.5 text-sm', disabled && 'pointer-events-none opacity-45')}>
      <input id={id} type="checkbox" className="sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <CheckboxBox checked={checked} indeterminate={indeterminate} />
      {label && <span className="text-ink-2">{label}</span>}
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border transition-colors duration-200 disabled:opacity-45',
        checked ? 'border-signal bg-signal' : 'border-line-strong bg-sunken',
      )}
    >
      <span className={cx('absolute size-4 rounded-full transition-all duration-200', checked ? 'left-[18px] bg-signal-ink' : 'left-[2px] bg-muted')} />
    </button>
  );
}

/** Segmented single-choice control. */
export function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string; hint?: string }[];
}) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-xl border px-3 py-2.5 text-left transition-all duration-150',
            value === o.value ? 'border-signal/60 bg-signal/[0.07]' : 'border-line bg-sunken/60 hover:border-line-strong',
          )}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <span className={cx('size-3.5 rounded-full border-2', value === o.value ? 'border-signal bg-signal shadow-[inset_0_0_0_2px_var(--color-surface)]' : 'border-line-strong')} />
            {o.label}
          </span>
          {o.hint && <span className="mt-1 block pl-[22px] text-xs text-muted">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

// ── Status / feedback ───────────────────────────────────────────────────────
const STATUS_STYLE: Record<RunStatus, { label: string; cls: string; dot: string }> = {
  running: { label: 'Running', cls: 'text-live border-live/30 bg-live/10', dot: 'bg-live live-dot' },
  succeeded: { label: 'Succeeded', cls: 'text-ok border-ok/25 bg-ok/10', dot: 'bg-ok' },
  failed: { label: 'Failed', cls: 'text-bad border-bad/25 bg-bad/10', dot: 'bg-bad' },
  cancelled: { label: 'Cancelled', cls: 'text-muted border-line-strong bg-raised', dot: 'bg-muted' },
  interrupted: { label: 'Interrupted', cls: 'text-warn border-warn/25 bg-warn/10', dot: 'bg-warn' },
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium', s.cls)}>
      <span className={cx('size-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'signal' | 'info'; className?: string }) {
  const tones = {
    neutral: 'border-line-strong bg-raised text-ink-2',
    ok: 'border-ok/25 bg-ok/10 text-ok',
    warn: 'border-warn/25 bg-warn/10 text-warn',
    bad: 'border-bad/25 bg-bad/10 text-bad',
    signal: 'border-signal/30 bg-signal/10 text-signal',
    info: 'border-info/25 bg-info/10 text-info',
  };
  return <span className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium', tones[tone], className)}>{children}</span>;
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-4 grid size-12 place-items-center rounded-2xl border border-line-strong bg-raised text-ink-2">{icon}</div>
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Alert({ tone = 'warn', title, children }: { tone?: 'warn' | 'bad' | 'info' | 'ok'; title?: string; children: ReactNode }) {
  const tones = {
    warn: 'border-warn/25 bg-warn/[0.06] text-warn',
    bad: 'border-bad/25 bg-bad/[0.06] text-bad',
    info: 'border-info/25 bg-info/[0.06] text-info',
    ok: 'border-ok/25 bg-ok/[0.06] text-ok',
  };
  return (
    <div className={cx('rounded-xl border px-4 py-3 text-[13px]', tones[tone])}>
      {title && <div className="mb-0.5 font-semibold">{title}</div>}
      <div className="text-ink-2">{children}</div>
    </div>
  );
}

// ── Modal ───────────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, description, children, footer, width = 'max-w-lg' }: {
  open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; footer?: ReactNode; width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  const titleId = useId();
  if (!open) return null;
  // Rendered into <body>: an ancestor with a transform or backdrop blur would otherwise pin the overlay to itself.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-canvas/70 p-4 pt-[10vh] backdrop-blur-sm" onMouseDown={onClose}>
      <div role="dialog" aria-modal aria-labelledby={titleId} className={cx('rise w-full rounded-2xl border border-line-strong bg-surface/90 shadow-pop backdrop-blur-xl', width)} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted transition-colors hover:bg-raised hover:text-ink" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'bad' | 'warn' | 'signal' }) {
  const toneCls = tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'signal' ? 'text-signal' : 'text-ink';
  return (
    <div className="panel px-5 py-4">
      <div className="eyebrow">{label}</div>
      <div className={cx('mt-2 text-[28px] font-semibold tracking-[-0.02em] tabular-nums', toneCls)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

// ── Skeletons: the shape of what is loading ─────────────────────────────────

/** One grey block (give it a size with className). Hidden from screen readers; wrap a group in <Loading>. */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span aria-hidden className={cx('skeleton block', className)} style={style} />;
}

/** Marks a skeleton region for assistive tech ("Loading …") while it shows. */
export function Loading({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <div role="status" aria-live="polite" aria-busy="true" className={className}><span className="sr-only">{label}</span>{children}</div>;
}

/** A row of stat cards. */
export function SkeletonStats({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cx('grid grid-cols-2 gap-3 md:grid-cols-4', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="panel space-y-3 px-5 py-4"><Skeleton className="h-3 w-20" /><Skeleton className="h-7 w-24" /><Skeleton className="h-3 w-16" /></div>
      ))}
    </div>
  );
}

/** A bar chart: a title line and bars of varied height. */
export function SkeletonChart({ bars = 30, height = 'h-24', className }: { bars?: number; height?: string; className?: string }) {
  return (
    <div className={className}>
      <div className="mb-2 flex justify-between"><Skeleton className="h-3 w-40" /><Skeleton className="h-3 w-10" /></div>
      <div className={cx('flex items-end gap-0.5 border-b border-line-strong', height)}>
        {Array.from({ length: bars }, (_, i) => <Skeleton key={i} className="flex-1 rounded-b-none" style={{ height: `${35 + ((i * 37) % 60)}%` }} />)}
      </div>
    </div>
  );
}

/** A table: a header line and rows. */
export function SkeletonTable({ rows = 6, cols = 4, className }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div className={cx('overflow-hidden rounded-lg border border-line', className)}>
      <div className="flex gap-4 bg-raised/50 px-3 py-2.5">{Array.from({ length: cols }, (_, i) => <Skeleton key={i} className="h-3 flex-1" />)}</div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 border-t border-line/50 px-3 py-3">
          {Array.from({ length: cols }, (_, c) => <Skeleton key={c} className={cx('h-3', c === 0 ? 'flex-[2]' : 'flex-1')} style={{ opacity: 1 - r * 0.08 }} />)}
        </div>
      ))}
    </div>
  );
}

/** Lines of text. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return <div className={cx('space-y-2', className)}>{Array.from({ length: lines }, (_, i) => <Skeleton key={i} className="h-3" style={{ width: `${i === lines - 1 ? 60 : 100 - i * 6}%` }} />)}</div>;
}
