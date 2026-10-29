-- Backup Console — the vault server key lives in Supabase (apply after 0002).
--
-- Backup runs decrypt credentials with the vault server key, without the vault password.
-- It used to come from a file (VAULT_SERVER_KEY_FILE); now the console keeps it here and
-- creates it on first use. Only the service role (the console's server) can read it.
--
-- Trade-off: whoever has the service-role key can read this key AND the vault, so they can
-- decrypt every stored credential. Keep the service-role key secret.

create table if not exists public.vault_keys (
  id          smallint primary key default 1 check (id = 1),
  -- 32 random bytes, base64.
  server_key  text not null check (length(server_key) between 40 and 64),
  created_at  timestamptz not null default now()
);

alter table public.vault_keys enable row level security;
revoke all on public.vault_keys from anon, authenticated;
