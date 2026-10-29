'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';

type Tone = 'ok' | 'bad' | 'info';
interface Toast { id: number; tone: Tone; message: string }

const Ctx = createContext<(message: string, tone?: Tone) => void>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Tone = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 7000 : 3800);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} role="status" className="rise pointer-events-auto flex items-start gap-3 rounded-xl border border-line-strong bg-raised px-4 py-3 text-sm shadow-pop">
            {t.tone === 'ok' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
              : t.tone === 'bad' ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-bad" />
                : <Info className="mt-0.5 size-4 shrink-0 text-info" />}
            <span className="text-ink-2">{t.message}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
