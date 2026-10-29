-- Backup Console — delete the whole vault and everything in it, to start again.
--
-- Run this in the Supabase SQL editor. It permanently deletes:
--   * every stored credential (Cloudflare account sets with their R2 / AWS storage),
--   * the vault itself (its data key and the vault password that opened it),
--   * the vault server key (public.vault_keys), so a new one is made with the new vault.
-- Nothing else is touched: users, presets, run history, logs and settings stay.
--
-- Afterwards:
--   1. Restart the console (npm run dev / npm start), so no old key stays in its memory.
--   2. Sign in as a super admin and open Credentials: it offers "Create the credential vault".
--      Choose the new vault password, then add the credentials again.
--   3. Presets still name the deleted credentials: edit each one and pick the new account set.
--      Backups using a deleted credential are refused ("Credential not found") until then.
--
-- This cannot be undone. Credentials are only stored encrypted, so they cannot be recovered
-- from a database backup either without the old vault password or server key.

begin;

-- Counts, so the result shows what was removed.
create temporary table vault_reset_counts on commit drop as
select (select count(*) from public.credentials) as credentials,
       (select count(*) from public.vault) as vault_rows;

delete from public.credentials;
delete from public.vault;
-- vault_keys exists once migration 0003 has been applied.
do $$
begin
  if to_regclass('public.vault_keys') is not null then
    delete from public.vault_keys;
  end if;
end $$;

insert into public.audit_log (actor_email, action, target, details)
select null, 'vault.reset', null,
       jsonb_build_object('by', 'supabase/maintenance/reset_vault.sql', 'credentials_deleted', credentials)
from vault_reset_counts;

select credentials as credentials_deleted, vault_rows as vault_deleted from vault_reset_counts;

commit;
