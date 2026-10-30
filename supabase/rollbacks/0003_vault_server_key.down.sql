-- Undoes 0003_vault_server_key.sql. WARNING: without this key, backup runs cannot decrypt
-- credentials (unless VAULT_SERVER_KEY is set in the environment to the same key). Copy it first:
--   select server_key from public.vault_keys;   -- keep it secret
drop table if exists public.vault_keys;
