import 'server-only';
import { HttpError } from './http';

// The tables of the operator tools (supabase/migrations/0019_ops_tools.sql): saved API console
// queries, and live Worker log sessions with their events.

export const OPS_NOT_SET_UP = 'This tool is not set up in the database yet: run supabase/migrations/0019_ops_tools.sql in the Supabase SQL editor, then reload this page';

/** A missing table or column (the migration not applied). */
export const notSetUp = (e: { code?: string; message: string }) => e.code === '42P01' || e.code === '42703' || e.code === 'PGRST205' || e.code === 'PGRST204' || /does not exist|schema cache/i.test(e.message);

/** Like supabase.must(), but a missing table is a clear 503 naming the migration. */
export function opsMust<T>(res: { data: T; error: { message: string; code?: string } | null }, what = 'Database request'): T {
  if (!res.error) return res.data;
  if (notSetUp(res.error)) throw new HttpError(503, OPS_NOT_SET_UP);
  throw new Error(`${what} failed: ${res.error.message}`);
}
