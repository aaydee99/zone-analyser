'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Copy, Download, Search } from 'lucide-react';
import { stripAnsi } from '@/lib/run-types';
import { copyText } from '@/lib/client';
import { Checkbox, cx } from './ui';
import { useToast } from './toast';

// backup.js only emits a handful of SGR codes; map them to theme colours.
const FG: Record<string, string> = { '31': 'text-bad', '32': 'text-ok', '33': 'text-warn', '34': 'text-info', '36': 'text-cyan' };

// Only the last lines are drawn (a big run has tens of thousands); "Show earlier lines" draws all.
const WINDOW = 2000;

interface Seg { text: string; cls: string }

function parseAnsi(line: string): Seg[] {
  const segs: Seg[] = [];
  let fg = '';
  let bold = false;
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const flush = (end: number) => {
    if (end > last) segs.push({ text: line.slice(last, end), cls: cx(fg, bold && 'font-semibold') });
  };
  while ((m = re.exec(line))) {
    flush(m.index);
    for (const code of (m[1] || '0').split(';')) {
      if (code === '0' || code === '') { fg = ''; bold = false; } else if (code === '1') bold = true; else if (FG[code]) fg = FG[code];
    }
    last = re.lastIndex;
  }
  flush(line.length);
  return segs;
}

type Level = 'INFO' | 'OK' | 'WARN' | 'ERROR' | 'OTHER';
const levelOf = (plain: string): Level => {
  const m = /^\[(INFO|OK|WARN|ERROR)\]/.exec(plain);
  return (m?.[1] as Level) ?? 'OTHER';
};

const Line = memo(function Line({ line, n }: { line: string; n: number }) {
  const segs = useMemo(() => parseAnsi(line), [line]);
  const plain = stripAnsi(line);
  const section = plain.startsWith('━━━');
  return (
    <div className={cx('group flex hover:bg-white/[0.025]', section && 'mt-2 border-t border-line/70 pt-2')}>
      <span className="w-12 shrink-0 pr-3 text-right text-faint/70 select-none">{n}</span>
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
        {segs.length ? segs.map((s, i) => <span key={i} className={s.cls}>{s.text}</span>) : ' '}
      </span>
    </div>
  );
});

export function Terminal({ lines, live, filename }: { lines: string[]; live: boolean; filename: string }) {
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollowing] = useState(true);
  // Where the drawn lines start while reading up (not following): new lines do not slide them away.
  const [held, setHeld] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const [levels, setLevels] = useState<Record<Level, boolean>>({ INFO: true, OK: true, WARN: true, ERROR: true, OTHER: true });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = Object.values(levels).every(Boolean);
    if (!q && all) return lines.map((l, i) => [l, i + 1] as const);
    const out: (readonly [string, number])[] = [];
    lines.forEach((l, i) => {
      const plain = stripAnsi(l);
      if (!levels[levelOf(plain)]) return;
      if (q && !plain.toLowerCase().includes(q)) return;
      out.push([l, i + 1]);
    });
    return out;
  }, [lines, query, levels]);

  const latest = Math.max(0, filtered.length - WINDOW);
  const from = showAll ? 0 : held !== null ? Math.min(held, latest) : latest;
  const shown = useMemo(() => (from ? filtered.slice(from) : filtered), [filtered, from]);
  const setFollow = (v: boolean) => { setFollowing(v); setHeld(v ? null : latest); };

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [shown, follow]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const plainText = () => lines.map(stripAnsi).join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([plainText()], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    URL.revokeObjectURL(url);
  };

  const counts = useMemo(() => {
    const c: Record<Level, number> = { INFO: 0, OK: 0, WARN: 0, ERROR: 0, OTHER: 0 };
    for (const l of lines) c[levelOf(stripAnsi(l))]++;
    return c;
  }, [lines]);

  return (
    <div className="overflow-hidden rounded-[14px] border border-line bg-terminal">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2.5">
        <div className="flex items-center gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-line-strong" /><span className="size-2.5 rounded-full bg-line-strong" /><span className="size-2.5 rounded-full bg-line-strong" />
        </div>
        <div className="relative min-w-[160px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter log…" className="input !h-8 !py-1 !pl-8 !text-[13px]" />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {(['OK', 'INFO', 'WARN', 'ERROR'] as const).map((lv) => (
            <Checkbox
              key={lv}
              checked={levels[lv]}
              onChange={(v) => setLevels((s) => ({ ...s, [lv]: v }))}
              label={<span className="font-mono text-[11.5px]">{lv} <span className="text-faint">{counts[lv]}</span></span>}
            />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setFollow(true)} className={cx('rounded-md p-2 transition-colors hover:bg-raised', follow ? 'text-signal' : 'text-muted')} title="Follow output" aria-label="Follow output" aria-pressed={follow}>
            <ArrowDownToLine className="size-4" />
          </button>
          <button onClick={async () => { await copyText(plainText()); toast('Log copied'); }} className="rounded-md p-2 text-muted transition-colors hover:bg-raised hover:text-ink" title="Copy log" aria-label="Copy log">
            <Copy className="size-4" />
          </button>
          <button onClick={download} className="rounded-md p-2 text-muted transition-colors hover:bg-raised hover:text-ink" title="Download log" aria-label="Download log">
            <Download className="size-4" />
          </button>
        </div>
      </div>
      <div ref={ref} onScroll={onScroll} className="h-[62vh] min-h-[360px] overflow-auto py-3 pr-4 font-mono text-[12.5px] leading-[1.65] text-ink-2">
        {from > 0 && (
          <button type="button" onClick={() => { setShowAll(true); setFollow(false); }} className="mb-2 ml-12 rounded-md border border-line-strong px-2.5 py-1 font-sans text-xs text-muted transition-colors hover:border-faint hover:text-ink">
            Show earlier lines ({from.toLocaleString()})
          </button>
        )}
        {shown.map(([l, n]) => <Line key={n} line={l} n={n} />)}
        {live && (
          <div className="flex pl-12 text-signal"><span className="inline-block h-4 w-2 animate-pulse bg-signal/80" /></div>
        )}
        {!live && lines.length === 0 && <div className="pl-12 text-faint">No output recorded.</div>}
      </div>
    </div>
  );
}
