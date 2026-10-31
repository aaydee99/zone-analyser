'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'summary',
  '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

/** Open traps, innermost last: only the top one handles Tab and Escape. */
const stack: symbol[] = [];

const focusables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
  .filter((el) => !el.closest('[inert],[hidden]') && el.getClientRects().length > 0);

/**
 * Keyboard handling for a modal surface (dialog, mobile menu) while `active`:
 * moves focus into `ref` (an element already focused inside it, e.g. by autoFocus, is kept;
 * otherwise the first focusable one not marked `data-skip-initial-focus`, else the container),
 * keeps Tab / Shift+Tab inside, closes on Escape, and gives focus back to whatever had it
 * before when it closes. Give the container `tabIndex={-1}` so it can hold focus itself.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const id = Symbol('focus-trap');
    stack.push(id);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (!node.contains(document.activeElement)) {
      const list = focusables(node);
      (list.find((el) => !el.hasAttribute('data-skip-initial-focus')) ?? list[0] ?? node).focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables(node);
      if (!list.length) { e.preventDefault(); node.focus(); return; }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === node || !node.contains(current))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (current === last || !node.contains(current))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
      // Back to the control that opened it, unless something else took focus meanwhile.
      if (previous?.isConnected && (!document.activeElement || document.activeElement === document.body || node.contains(document.activeElement))) previous.focus();
    };
  }, [active, ref]);
}
