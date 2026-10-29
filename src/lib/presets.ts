import 'server-only';
import { db, must } from './supabase';
import { newId } from './store';
import { normalizeConfig, type BackupConfig } from './config';
import { HttpError } from './http';
import { audit } from './audit';
import type { Me } from './auth';

export interface Preset { id: string; name: string; config: BackupConfig; updatedAt: string }

interface Row { id: string; name: string; config: BackupConfig; updated_at: string }
const view = (r: Row): Preset => ({ id: r.id, name: r.name, config: normalizeConfig(r.config), updatedAt: r.updated_at });

export async function listPresets(): Promise<Preset[]> {
  return (must(await db().from('presets').select('id, name, config, updated_at').order('name'), 'Listing presets') as Row[]).map(view);
}

export async function getPreset(id: string): Promise<Preset | null> {
  const r = must(await db().from('presets').select('id, name, config, updated_at').eq('id', id).maybeSingle(), 'Reading preset') as Row | null;
  return r ? view(r) : null;
}

export async function savePreset(me: Me, name: string, config: BackupConfig, id?: string): Promise<Preset> {
  const clean = (name ?? '').trim().slice(0, 60);
  if (!clean) throw new HttpError(400, 'Preset name is required');
  const all = await listPresets();
  const existing = all.find((p) => (id ? p.id === id : p.name.toLowerCase() === clean.toLowerCase()));
  const now = new Date().toISOString();
  const values = { name: clean, config: normalizeConfig(config), updated_by: me.id, updated_at: now };
  const { data, error } = existing
    ? await db().from('presets').update(values).eq('id', existing.id).select('id, name, config, updated_at').single()
    : await db().from('presets').insert({ id: newId(), ...values, created_by: me.id }).select('id, name, config, updated_at').single();
  if (error?.code === '23505') throw new HttpError(409, 'A preset with this name already exists');
  if (error) throw new Error(`Saving preset failed: ${error.message}`); // logged; the client gets a generic 500
  await audit(me, existing ? 'preset.updated' : 'preset.created', clean);
  return view(data as Row);
}

export async function deletePreset(me: Me, id: string) {
  const p = await getPreset(id);
  if (!p) return;
  must(await db().from('presets').delete().eq('id', id), 'Deleting preset');
  await audit(me, 'preset.deleted', p.name);
}
