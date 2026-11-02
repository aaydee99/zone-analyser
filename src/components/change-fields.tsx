'use client';

import { useState } from 'react';
import type { CfChange, CfHistoryResult } from '@/lib/cf-audit-report';
import { cx } from './ui';

// A Cloudflare change, field by field: the old value and the new one. Shared by Cloudflare activity
// and the zone timeline.

const FIELD_ROWS = 6;

/** The fields a change touched, with their old and new values (`history`: old values looked up in Cloudflare Resource History). */
export function FieldTable({ c, history }: { c: CfChange; history?: CfHistoryResult }) {
  const [all, setAll] = useState(false);
  const rows = history?.changes.length ? history.changes : c.changes;
  if (!rows.length) return null;
  const showOld = rows.some((f) => f.old !== undefined) || c.actionType === 'update';
  const showNew = rows.some((f) => f.new !== undefined);
  const visible = all ? rows : rows.slice(0, FIELD_ROWS);
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[420px] text-left text-[12px]">
        <thead className="bg-raised/50 text-muted">
          <tr>
            <th className="w-[28%] min-w-[150px] px-3 py-1.5 font-medium">Field</th>
            {showOld && <th className="px-3 py-1.5 font-medium">Old value</th>}
            {showNew && <th className="px-3 py-1.5 font-medium">New value</th>}
          </tr>
        </thead>
        <tbody className="font-mono">
          {visible.map((f, i) => (
            <tr key={`${f.path}-${i}`} className="border-t border-line/50 align-top">
              <td className="px-3 py-1.5 break-all text-ink-2">{f.path}</td>
              {showOld && <td className={cx('px-3 py-1.5 break-all', f.old !== undefined ? 'text-bad/90' : 'text-faint')}>{f.old ?? (c.oldSource === 'lookup' && !history ? 'not in this period' : '—')}</td>}
              {showNew && <td className={cx('px-3 py-1.5 break-all', f.new !== undefined ? 'text-ok' : 'text-faint')}>{f.new ?? (c.actionType === 'delete' ? 'deleted' : '—')}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > FIELD_ROWS && (
        <button type="button" onClick={() => setAll(!all)} className="w-full border-t border-line/50 px-3 py-1.5 text-left text-xs text-muted hover:text-ink">
          {all ? 'Show fewer fields' : `Show all ${rows.length} fields`}
        </button>
      )}
    </div>
  );
}
