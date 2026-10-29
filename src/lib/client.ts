'use client';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

/**
 * JSON fetch for the console API. A 401 means the session ended — bounce to sign-in.
 * (A locked vault answers 423, which stays on the page.)
 */
export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: 'no-store',
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/setup') && !path.startsWith('/api/vault/')) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`, body);
  return body as T;
}

export function relTime(iso?: string | number | null): string {
  if (!iso) return '—';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 604800) return `${Math.round(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function duration(startIso: string, endIso?: string): string {
  const ms = (endIso ? Date.parse(endIso) : Date.now()) - Date.parse(startIso);
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

export const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—');

export async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}
