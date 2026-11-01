# Rollbacks (down migrations)

Supabase applies `supabase/migrations/*.sql` forward only. Each file here undoes one migration.
Run them by hand, newest first, in the Supabase SQL editor (or `psql`), and only after a backup:
most of them delete tables and their data.

| Migration | Rollback | Loses data |
| --- | --- | --- |
| 0021_zone_audits | 0021_zone_audits.down.sql | **every stored security audit (the per-zone history)** |
| 0020_reports | 0020_reports.down.sql | **report definitions and every report made (the history)**, and the Slack command allow-list (monitoring data is kept) |
| 0019_ops_tools | 0019_ops_tools.down.sql | **saved API console queries**; live Worker log sessions in progress (their events are only kept while a session runs) |
| 0018_zone_health | 0018_zone_health.down.sql | no (only the zone health scores, recomputed from monitoring when 0018 is applied again) |
| 0016_zone_search | 0016_zone_search.down.sql | **comparison templates** and their results; the search index (rebuilt from backups and monitoring with "Rebuild index" once 0016 is applied again) |
| 0015_zone_meta | 0015_zone_meta.down.sql | **zone tags, owners, contacts and notes**, and every user's favourite zones, recent zones and saved views (export the tags as CSV from Zone tags first) |
| 0014_rate_limits | 0014_rate_limits.down.sql | no (only the shared rate-limit counters and the list of relayed calls already run; each instance counts in memory again) |
| 0013_worker_locks | 0013_worker_locks.down.sql | no (only the shared job locks and which approvals were carried out; each worker's own lock and approval records stay) |
| 0012_monitor_claims | 0012_monitor_claims.down.sql | no (only which worker holds a monitoring unit, and which channel each finding was sent to) |
| 0011_monitor_queue | 0011_monitor_queue.down.sql | the monitoring queue, per-zone results and drift baselines (findings are kept; drift takes new baselines on its next check) |
| 0010_monitoring | 0010_monitoring.down.sql | check results, findings, received Cloudflare alerts, the notification log |
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
