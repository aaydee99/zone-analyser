-- Backup Console — reset the vault password, keeping every stored credential.
--
-- Run this in the Supabase SQL editor when the vault password is lost or must be replaced.
-- It does NOT touch public.credentials. It removes only the copy of the data key that is
-- wrapped with the old vault password (dek_pw, and its scrypt salt in kdf). The copy wrapped
-- with the vault server key (dek_server) stays, so:
--
--   1. Run this script.
--   2. Sign in as a super admin and open Credentials: it asks for a new vault password.
--   3. The console opens the data key with the server key (public.vault_keys) and wraps
--      it under the new password. Credentials, presets and backups are unchanged, and the
--      audit log records vault.password_reset.
--
-- The console must be running with the same server key the vault was created with (or last
-- re-sealed with). Backups keep working the whole time; they never need the vault password.
-- Anyone who had the vault unlocked is locked out when the new password is set.

begin;

-- dek_pw and kdf are empty between this reset and the new password.
alter table public.vault alter column dek_pw drop not null;
alter table public.vault alter column kdf drop not null;

do $$
declare
  v public.vault%rowtype;
begin
  select * into v from public.vault where id = 1 for update;
  if not found then
    raise exception 'There is no vault yet: create it in the console (Credentials) instead.';
  end if;
  -- Without the server-key copy, clearing dek_pw would make every credential unrecoverable.
  if v.dek_server is null or jsonb_typeof(v.dek_server) <> 'object' or not (v.dek_server ? 'ct') then
    raise exception 'The vault has no server-key copy of its data key (dek_server), so the password cannot be reset without losing the credentials. Nothing was changed. If you know the current vault password: unlock the vault once in the console (it re-creates the server-key copy), then use Change vault password there.';
  end if;
  update public.vault set dek_pw = null, kdf = null, updated_at = now() where id = 1;
end $$;

insert into public.audit_log (actor_email, action, target, details)
values (null, 'vault.password_cleared', null, jsonb_build_object('by', 'supabase/maintenance/reset_vault_password.sql'));

commit;
