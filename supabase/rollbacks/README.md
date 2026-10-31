# Rollbacks (down migrations)

Supabase applies `supabase/migrations/*.sql` forward only. Each file here undoes one migration.
Run them by hand, newest first, in the Supabase SQL editor (or `psql`), and only after a backup:
most of them delete tables and their data.

| Migration | Rollback | Loses data |
| --- | --- | --- |
| 0008_indexes_and_guards | 0008_indexes_and_guards.down.sql | no |
| 0009_worker_calls_realtime | 0009_worker_calls_realtime.down.sql | no |
| 0007_worker_versions | 0007_worker_versions.down.sql | the version list (rebuilt on use) |
| 0006_worker_wakeups | 0006_worker_wakeups.down.sql | the last start request |
| 0005_worker_state | 0005_worker_state.down.sql | the worker's mirrored records (approvals, restore history) |
| 0004_worker | 0004_worker.down.sql | worker heartbeats and queued calls |
| 0003_vault_server_key | 0003_vault_server_key.down.sql | **the vault server key: backups can no longer decrypt credentials** |
| 0002_hardening | 0002_hardening.down.sql | the setup claim; default privileges go back to Supabase's |
| 0001_backup_console | 0001_backup_console.down.sql | **everything: users, sessions, vault, credentials, runs, logs, audit** |

To roll back a deploy, you usually do NOT need these: every migration only adds tables, columns
and indexes, so older code keeps working with the newer schema.
