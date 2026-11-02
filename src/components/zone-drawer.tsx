'use client';

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Globe, PanelRightOpen, X } from 'lucide-react';
import { useZoneStore } from '@/lib/stores/zone-store';
import { ZoneView } from '@/app/console/(app)/zone-explorer/zone-view';
import { ZonePicker, type PickedZone } from '@/app/console/(app)/investigate/shared';
import { EmptyState, cx } from './ui';
import { useFocusTrap } from './use-focus-trap';

/**
 * The Zone explorer as a side panel, on any console page: choose a zone (or a page opens it on one
 * with openZonePanel) and see everything the zone explorer shows. Its data is the zone store's, so
 * what the page or the panel read is shown by both, and "Read again" here updates both.
 */
export function ZoneDrawer() {
  const drawer = useZoneStore((s) => s.drawer);
  const close = useZoneStore((s) => s.closeDrawer);
  const openDrawer = useZoneStore((s) => s.openDrawer);
  const panel = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<PickedZone | null>(null);
  const open = drawer !== null;
  // Focus moves in on open, Tab stays inside, Escape closes, focus goes back to the opener.
  useFocusTrap(panel, open, close);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-canvas/60 backdrop-blur-sm" onMouseDown={close}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal aria-label="Zone explorer panel" onMouseDown={(e) => e.stopPropagation()}
        className="rise flex h-full w-full max-w-4xl flex-col border-l border-line-strong bg-canvas shadow-pop outline-none">
        <div className="flex items-start gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0 flex-1">
            <ZonePicker label="Zone explorer" value={picked} hint="Any zone a stored credential can read. What you read here is shared with the Zone explorer page."
              onChange={(z) => { setPicked(z); if (z) openDrawer(z.id); }} />
          </div>
          <button type="button" onClick={close} data-skip-initial-focus className="mt-6 rounded-md p-1.5 text-muted transition-colors hover:bg-raised hover:text-ink" aria-label="Close the zone panel">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {drawer ? <ZoneView key={drawer} zoneId={drawer} explorerLink />
            : <EmptyState icon={<Globe className="size-5" />} title="Choose a zone" description="Its full configuration is read from Cloudflare (or shown from what this tab read already)." />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A small button beside a zone's name: opens it in the zone panel, without leaving the page. */
export function ZonePeek({ zoneId, zoneName, className }: { zoneId: string; zoneName: string; className?: string }) {
  const openDrawer = useZoneStore((s) => s.openDrawer);
  return (
    <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openDrawer(zoneId); }}
      className={cx('inline-flex shrink-0 items-center rounded p-1 text-faint transition-colors hover:bg-raised hover:text-ink', className)}
      aria-label={`Quick view ${zoneName} in the zone panel`} title="Quick view in the zone panel">
      <PanelRightOpen className="size-3.5" aria-hidden />
    </button>
  );
}
