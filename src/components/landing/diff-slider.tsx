'use client';

import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ChevronsLeftRight } from 'lucide-react';

// Before / after over one backed-up block: drag (or use the arrow keys) between the live zone after an
// accidental change and the same block put back from the backup. Sample HCL in the shape the backup
// writes (cf-terraforming, Terraform provider v5).

type Line = { text: string; changed?: boolean };

const head = (label: string): Line[] => [
  { text: `resource "cloudflare_ruleset" "${label}" {` },
  { text: '  zone_id = "023e105f4ecef8ad9ca31a8372d0c353"' },
  { text: '  kind    = "zone"' },
  { text: '  phase   = "http_request_firewall_custom"' },
  { text: '  rules = [{' },
  { text: '    description = "Admin: office only"' },
  { text: '    expression  = "(http.request.uri.path wildcard \\"/admin*\\" and not ip.src in $office)"' },
];
const LABEL = 'terraform_managed_resource_7c1e_0';

const LIVE: Line[] = [
  ...head(LABEL),
  { text: '    action      = "log"', changed: true },
  { text: '    enabled     = false', changed: true },
  { text: '  }]' },
  { text: '}' },
];
const RESTORED: Line[] = [
  ...head(LABEL),
  { text: '    action      = "block"', changed: true },
  { text: '    enabled     = true', changed: true },
  { text: '  }]' },
  { text: '}' },
];

function Code({ lines, tone }: { lines: Line[]; tone: 'del' | 'add' }) {
  return (
    <pre className="m-0 font-mono text-[11.5px] leading-[1.7] whitespace-pre-wrap break-all text-ink-2 sm:text-[12.5px]">
      {lines.map((l, i) => (
        <span key={i} className={l.changed ? `block ${tone === 'del' ? 'lp-del' : 'lp-add'}` : 'block'}>
          <span aria-hidden="true" className="mr-3 inline-block w-3 text-right text-faint select-none">{l.changed ? (tone === 'del' ? '−' : '+') : ''}</span>
          {l.text}
        </span>
      ))}
    </pre>
  );
}

export function DiffSlider() {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(50);
  const [dragging, setDragging] = useState(false);

  const fromPointer = useCallback((clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setPos(Math.round(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100))));
  }, []);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    fromPointer(e.clientX);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => { if (dragging) fromPointer(e.clientX); };
  const onUp = () => setDragging(false);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -20, PageUp: 20 }[e.key];
    if (step !== undefined) { e.preventDefault(); setPos((p) => Math.min(100, Math.max(0, p + step))); }
    else if (e.key === 'Home') { e.preventDefault(); setPos(0); }
    else if (e.key === 'End') { e.preventDefault(); setPos(100); }
  };

  return (
    <div>
      <div ref={box} className={`lp-compare relative select-none ${dragging ? 'is-dragging' : ''}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {/* Restored (underneath) */}
        <div className="lp-compare-pane">
          <p className="lp-compare-tag text-ok">Restored from backup</p>
          <Code lines={RESTORED} tone="add" />
        </div>
        {/* Live after the accident (on top, clipped to the handle) */}
        <div className="lp-compare-pane lp-compare-top" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
          <p className="lp-compare-tag text-bad">Live now · changed by accident</p>
          <Code lines={LIVE} tone="del" />
        </div>
        <div className="lp-compare-rule" style={{ left: `${pos}%` }} aria-hidden="true" />
        <div role="slider" tabIndex={0} aria-label="Compare the live rule with the restored rule"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={pos}
          aria-valuetext={pos >= 100 ? 'Showing the live rule' : pos <= 0 ? 'Showing the restored rule' : `${pos}% live, ${100 - pos}% restored`}
          onKeyDown={onKey}
          className="lp-compare-handle" style={{ left: `${pos}%` }}>
          <ChevronsLeftRight aria-hidden="true" className="size-4" />
        </div>
      </div>
      <p className="mt-3 text-[12.5px] text-faint">Sample rule. Drag the handle, or focus it and use the arrow keys.</p>
    </div>
  );
}
