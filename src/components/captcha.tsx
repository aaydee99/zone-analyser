'use client';

import { useEffect, useRef } from 'react';

// Cloudflare Turnstile widget for the public forms. Renders nothing while CAPTCHA is off
// (no site key). The token it yields is checked by the server (src/lib/captcha.ts).

interface Turnstile {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
}
declare global { interface Window { turnstile?: Turnstile } }

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { loading = null; reject(new Error('Could not load the CAPTCHA')); };
    document.head.appendChild(s);
  });
  return loading;
}

/** `resetKey`: change it to get a fresh challenge (a token is single-use, e.g. after a failed sign-in). */
export function Captcha({ siteKey, onToken, resetKey = 0 }: { siteKey: string | null; onToken: (token: string) => void; resetKey?: number }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!siteKey || !el.current) return;
    let id: string | null = null;
    let live = true;
    onToken('');
    loadScript().then(() => {
      if (!live || !el.current || !window.turnstile) return;
      id = window.turnstile.render(el.current, {
        sitekey: siteKey,
        callback: (t: string) => onToken(t),
        'expired-callback': () => onToken(''),
        'error-callback': () => onToken(''),
      });
    }).catch(() => onToken(''));
    return () => { live = false; if (id && window.turnstile) window.turnstile.remove(id); };
  }, [siteKey, onToken, resetKey]);
  return siteKey ? <div ref={el} className="min-h-[65px]" /> : null;
}
