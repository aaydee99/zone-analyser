# Operations

How to keep the Backup Console running: monitoring, rolling back, backups, rotating secrets, and
writing up what went wrong. Setup is in [README.md](README.md); the Cloudflare side in
[CLOUDFLARE.md](CLOUDFLARE.md).

The console has three moving parts:

| Part | Where | Starts / deploys |
| --- | --- | --- |
| Web (UI and API) | Vercel, behind Cloudflare at `console.ak-cflabs.com` | every push to `main` |
| Worker (backups, restores, Cloudflare calls) | GitHub Actions, `Console worker` workflow | on demand from the web; stops when idle |
| Database and sign-in | Supabase | migrations in `supabase/migrations`, applied by hand |

## Shipping

- `main` always works: change things on a branch, open a pull request, merge when **CI** is green.
  CI (`.github/workflows/ci.yml`) installs from the lock file, fails on high or critical known
  vulnerabilities in production dependencies, type-checks and builds.
- Make Vercel deploy only what passed: GitHub › Settings › Branches › add a rule for `main`:
  require a pull request and the `CI / check` status. Vercel then only ever sees passing commits.
  Pull requests get Vercel preview deployments automatically; previews must use a **separate
  Supabase project** (Vercel › Settings › Environment Variables › scope the Supabase values to
  *Preview*), never production's.
- Database changes: a new numbered file in `supabase/migrations` and its undo in
  `supabase/rollbacks` (see the README there). Apply it in the Supabase SQL editor **before**
  merging code that needs it. Migrations only add, so older code keeps working with a newer schema.

## Monitoring

Check these every minute from an uptime service (Better Stack, UptimeRobot, or Cloudflare Health
Checks on the Enterprise plan):

| URL | Healthy when | Means when failing |
| --- | --- | --- |
| `https://console.ak-cflabs.com/api/health` | HTTP 200 and `"ok":true` | the console cannot reach Supabase (503), or the web is down |
| `https://console.ak-cflabs.com/login` | HTTP 200 | the web (Vercel) or Cloudflare in front of it is down |
| `https://status.supabase.com` | provider says operational | Supabase outage |
| `https://www.githubstatus.com` | Actions operational | the worker cannot start |

`/api/health` needs no session and says only `ok`, `database`, `databaseMs` and `worker`
(`online` or `offline`; offline is normal — the worker starts when needed).

How fast the worker picks up calls: with `supabase/migrations/0009_worker_calls_realtime.sql` applied,
its log says `queue: Supabase Realtime connected` and each call is taken as soon as it is queued.
`Supabase Realtime not available … polling instead` means it asks every 100–250 ms instead (slower,
still working): check that the migration ran and that Realtime is on (Supabase › Realtime).

Alerts worth setting:

- The two console URLs above failing twice in a row → page/notify.
- GitHub › Settings › Notifications › Actions: email on failed workflow runs (the worker and CI).
- Vercel › Settings › Notifications: failed deployments.
- Supabase › Reports: database CPU and disk; the free plan pauses inactive projects.
- A public status page: the uptime service's status page with the two console checks is enough.

## Rolling back a bad deploy

1. **Web:** Vercel › Deployments › the last good one › **Promote to Production** (instant; no build).
2. **Worker:** it runs whatever is on `main` when it starts. Revert the bad commit on `main`
   (`git revert <sha>` and push), then GitHub › Actions › Console worker › cancel the running
   run; the next request starts a worker with the reverted code. (A new run also cancels the old
   one by itself.)
3. **Database:** usually nothing to do (migrations only add). If a migration itself is the
   problem, take a backup, then run its file from `supabase/rollbacks`.
4. Write a postmortem (below) if users were affected.

## Database backups and the restore test

- Backups are Supabase's: Supabase › Database › Backups. Daily backups come with the paid plans;
  point-in-time recovery is an add-on. **The free plan has no backups you can restore** — export
  regularly (`pg_dump`) if you stay on it.
- Test a restore every quarter: restore a backup into a **new** Supabase project, then run
  `SOURCE_DB_URL=<production, read only> TEST_DB_URL=<the new project> bash scripts/db-restore-test.sh`.
  It copies the console's tables and compares every table's row count. Delete the test project
  afterwards (it holds the vault's ciphertext).

## Rotating secrets and tokens

| Secret | Where it lives | Rotate without downtime |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | Vercel env, GitHub repository secrets | Supabase › Settings › API keys: create new keys, put them in Vercel and GitHub, redeploy, cancel the worker run, then revoke the old keys. |
| `CONSOLE_ORIGIN_SECRET` | Vercel env + the Cloudflare Transform Rule | Set Vercel to `new,old` (both accepted), redeploy, change the Cloudflare rule to `new`, then set Vercel to `new`. |
| Cloudflare API tokens, R2 / AWS keys (stored credentials) | the console's vault | Create the new token at the provider, edit the credential in Vault, run a backup, then delete the old token. |
| Vault password | only people | Vault › change password (the data key is re-wrapped; nothing is re-encrypted). |
| Vault server key | Supabase `vault_keys` | Rarely needed. Replace the row's `server_key` (32 random bytes, base64), then a super admin unlocks the vault once (Credentials): that re-seals the data key for the new key. Backups cannot decrypt credentials in between, so do it when none runs. |
| `WORKER_GITHUB_TOKEN` | Vercel env | New fine-grained token (Actions: read and write on this repository only), update Vercel, redeploy, delete the old token. |
| `TURNSTILE_SECRET_KEY` | Vercel env | Cloudflare › Turnstile › rotate secret (the old one keeps working for a while), update Vercel. |
| `REDIS_URL` password | Vercel env, GitHub secret | Add a second password at the provider, switch both, remove the old one. |

## Postmortem template

```text
Title:            what broke, in one line
Date / duration:  when it started, when it was fixed (UTC)
Impact:           who could not do what, for how long
Detection:        how we found out (user report, alert, …)
Root cause:       the actual reason (not the symptom)
Trigger:          what made it happen now
Fix:              what was changed (commits)
What went well / badly:
Follow-ups:       owner + date for each
```

### Example: the zone explorer answered 500 after visiting traffic analytics (October 2026)

- **Impact:** opening the zone explorer right after the traffic page failed with HTTP 500 until
  the traffic reads finished (minutes).
- **Detection:** user report.
- **Root cause (most likely; not reproduced outside production):** the traffic page polled the API
  every 3 seconds while Cloudflare was being read, and its loops did not stop when the page was
  left. Each poll held one of the worker's 8 slots for up to 20 seconds, so the zone explorer's
  own calls (list, summary, four sections at a time) waited behind them and failed.
- **Fix:** the loops end when their page or window closes; a poll for a running read waits 5
  seconds instead of 20; both pages share one zone list per browser tab.
- **Follow-ups:** an uptime check on `/api/health`; watch worker logs for `queue:` lines.
