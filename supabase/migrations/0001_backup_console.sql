-- Backup Console schema.
--
-- Every table has row-level security ON and NO policies: the anon and
-- authenticated keys can read nothing. Only the console server, using the
-- service-role key, touches these tables, and it enforces RBAC itself.
-- Credential secrets are encrypted by the server before they are written here;
-- Supabase only ever stores ciphertext.

create type public.app_role as enum ('super_admin', 'admin', 'operator', 'viewer');

-- ── Users ────────────────────────────────────────────────────────────────────
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null,
  display_name  text not null default '',
  role          public.app_role not null default 'viewer',
  disabled      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index profiles_email_key on public.profiles (lower(email));

-- Console sessions (opaque cookie; only its SHA-256 is stored).
create table public.sessions (
  token_hash   text primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  ip           text,
  user_agent   text
);
create index sessions_user_idx on public.sessions (user_id);

-- ── Vault ────────────────────────────────────────────────────────────────────
-- One data key (DEK) encrypts every credential. It is stored wrapped twice:
--   dek_pw     — by scrypt(vault password): super-admin access to the vault UI
--   dek_server — by VAULT_SERVER_KEY (server env): lets backup runs decrypt
create table public.vault (
  id          smallint primary key default 1 check (id = 1),
  kdf         jsonb not null,
  dek_pw      jsonb not null,
  dek_server  jsonb not null,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.credentials (
  id           text primary key,
  kind         text not null check (kind in ('cloudflare', 'r2', 'aws')),
  name         text not null,
  -- AES-256-GCM of {fields, notes} under the DEK; AAD = credential id
  sealed       jsonb not null,
  last_test    jsonb,
  last_used_at timestamptz,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ── Backups ──────────────────────────────────────────────────────────────────
create table public.presets (
  id          text primary key,
  name        text not null,
  config      jsonb not null,
  created_by  uuid references public.profiles (id) on delete set null,
  updated_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index presets_name_key on public.presets (lower(name));

create table public.runs (
  id               text primary key,
  status           text not null check (status in ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  exit_code        integer,
  preset_name      text,
  config           jsonb not null,
  output_dir       text,
  credential_names jsonb not null default '{}'::jsonb,
  command          text not null default '',
  summary          jsonb not null default '{}'::jsonb,
  started_by       uuid references public.profiles (id) on delete set null,
  started_by_email text
);
create index runs_started_idx on public.runs (started_at desc);

create table public.run_logs (
  id      bigint generated always as identity primary key,
  run_id  text not null references public.runs (id) on delete cascade,
  seq     integer not null,
  line    text not null
);
create index run_logs_run_seq_idx on public.run_logs (run_id, seq);

create table public.settings (
  id          smallint primary key default 1 check (id = 1),
  data        jsonb not null default '{}'::jsonb,
  updated_by  uuid references public.profiles (id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- ── Audit ────────────────────────────────────────────────────────────────────
create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid references public.profiles (id) on delete set null,
  actor_email text,
  action      text not null,
  target      text,
  details     jsonb
);
create index audit_log_at_idx on public.audit_log (at desc);

-- ── Lock everything down to the service role ─────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['profiles', 'sessions', 'vault', 'credentials', 'presets', 'runs', 'run_logs', 'settings', 'audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
