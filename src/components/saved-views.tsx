'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { Bookmark, Trash2 } from 'lucide-react';
import { api } from '@/lib/client';
import { Button, Field, Modal } from './ui';
import { useToast } from './toast';

// Named views of a page for the signed-in user: the page's query string (its filters) under a name.
// Choosing one applies it; "Save view" keeps the current one. Read once when the page opens.

interface SavedView { id: string; path: string; name: string; query: string; createdAt: string }

export function SavedViews({ path, query, onApply }: { path: string; query: string; onApply: (query: string) => void }) {
  const toast = useToast();
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState('');
  const selectId = useId();
  const load = useCallback(() => api<{ views: SavedView[] }>(`/api/me/views?path=${encodeURIComponent(path)}`).then((r) => setViews(r.views)).catch(() => setViews([])), [path]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      await api('/api/me/views', { method: 'POST', json: { path, name, query } });
      toast(`View “${name.trim()}” saved`);
      setOpen(false);
      await load();
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };
  const remove = async () => {
    const v = views?.find((x) => x.id === picked);
    if (!v) return;
    try { await api(`/api/me/views/${v.id}`, { method: 'DELETE' }); setPicked(''); toast(`View “${v.name}” deleted`, 'info'); await load(); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!!views?.length && (
        <>
          <label htmlFor={selectId} className="sr-only">Saved views</label>
          <select id={selectId} className="input !h-8 !w-auto max-w-[220px] !py-0 !text-[12.5px]" value={picked}
            onChange={(e) => { setPicked(e.target.value); const v = views.find((x) => x.id === e.target.value); if (v) onApply(v.query); }}>
            <option value="">Saved views…</option>
            {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          {picked && <button type="button" className="rounded p-1.5 text-muted hover:bg-raised hover:text-bad" onClick={remove} aria-label="Delete this saved view" title="Delete this saved view"><Trash2 className="size-3.5" /></button>}
        </>
      )}
      <Button size="sm" variant="ghost" icon={<Bookmark className="size-3.5" />} onClick={() => { setName(''); setOpen(true); }} disabled={!query}
        title={query ? 'Save these filters under a name' : 'Choose a filter or a zone first'}>Save view</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Save this view" description="Only you see your saved views. Saving with an existing name replaces it."
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>Save</Button></>}>
        <Field label="Name">
          <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Payments, production" autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void save(); }} />
        </Field>
        <p className="mt-2 break-all font-mono text-[11px] text-faint">?{query}</p>
      </Modal>
    </div>
  );
}
