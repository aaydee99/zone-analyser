# Backup Console

A web dashboard for `backup.js` (Cloudflare → Terraform backups) with role-based access and an encrypted credential vault. Data lives in Supabase.

## Set up

1. **Supabase project**: create one at supabase.com (or run one locally).
2. **Schema**: in the Supabase SQL editor, run every file in [`supabase/migrations`](supabase/migrations), in order: [`0001_backup_console.sql`](supabase/migrations/0001_backup_console.sql), [`0002_hardening.sql`](supabase/migrations/0002_hardening.sql), [`0003_vault_server_key.sql`](supabase/migrations/0003_vault_server_key.sql), [`0004_worker.sql`](supabase/migrations/0004_worker.sql), [`0005_worker_state.sql`](supabase/migrations/0005_worker_state.sql), [`0006_worker_wakeups.sql`](supabase/migrations/0006_worker_wakeups.sql), [`0007_worker_versions.sql`](supabase/migrations/0007_worker_versions.sql), [`0008_indexes_and_guards.sql`](supabase/migrations/0008_indexes_and_guards.sql), [`0009_worker_calls_realtime.sql`](supabase/migrations/0009_worker_calls_realtime.sql), [`0010_monitoring.sql`](supabase/migrations/0010_monitoring.sql), [`0011_monitor_queue.sql`](supabase/migrations/0011_monitor_queue.sql), [`0012_monitor_claims.sql`](supabase/migrations/0012_monitor_claims.sql), [`0013_worker_locks.sql`](supabase/migrations/0013_worker_locks.sql), [`0014_rate_limits.sql`](supabase/migrations/0014_rate_limits.sql), [`0015_zone_meta.sql`](supabase/migrations/0015_zone_meta.sql), [`0016_zone_search.sql`](supabase/migrations/0016_zone_search.sql), [`0018_zone_health.sql`](supabase/migrations/0018_zone_health.sql), [`0019_ops_tools.sql`](supabase/migrations/0019_ops_tools.sql) and [`0020_reports.sql`](supabase/migrations/0020_reports.sql) and [`0021_zone_audits.sql`](supabase/migrations/0021_zone_audits.sql) (there is no 0017). When you update the console, run any new ones the same way.
3. **Turn off public sign-up**: go to Authentication › Sign In / Providers and disable *Allow new users to sign up*. The console creates accounts itself through the admin API. Settings › Environment warns you if sign-up is still on.
4. **Environment**: fill in `.env.local` (template: [`.env.example`](.env.example)):

   | Variable | Where |
   |---|---|
   | `SUPABASE_URL` | Project Settings › API › Project URL |
   | `SUPABASE_ANON_KEY` | Project Settings › API › anon / publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Project Settings › API › service_role / secret key. **Server only.** |
   | `REDIS_URL` | Optional. Redis for the shared cache of Cloudflare reads, e.g. `redis://127.0.0.1:6379` (`rediss://user:password@host:6380` when it's not on this machine). Without it the cache is kept in memory. See [Cache](#cache). |
   | `CONSOLE_ALLOWED_HOSTS` | Optional. By default the console answers to any host name. Set a comma-separated list (for example `backups.example.com`) to answer only to those and the loopback names. `*` allows any host. Names other than loopback must be reached over HTTPS through a TLS proxy. |

5. **Run it**:
   ```bash
   npm install
   npm run build
   npm start            # http://127.0.0.1:4400  (bound to localhost only)
   ```
6. **First super admin**: open the console. The setup page asks for a **setup token**, which the server prints in its terminal and saves to `data/setup-token.txt`. That proves you're at the server, not a web page. Everyone else is added under **Users & roles**.

`terraform` and `cf-terraforming` are downloaded automatically the first time a backup needs them. terraform's checksums must carry a valid signature from HashiCorp's release key, pinned by fingerprint in [`src/lib/tools.ts`](src/lib/tools.ts). cf-terraforming publishes no signature, so it is checked against its checksums only. Node.js **20.9 or newer** is required (Next.js 16 needs it; CI uses Node 22). The full list of environment variables is under [All environment variables](#all-environment-variables).

### All environment variables

Every variable the console, the worker (`scripts/worker.mjs`) and `backup.js` read. Only names, defaults and meanings are listed here; never commit real values. Server variables are never sent to the browser, except those starting with `NEXT_PUBLIC_`, which are built into the pages.

<!-- BEGIN env-table: one row per variable. Append new console variables above the END marker. -->

| Variable | Default | Meaning |
|---|---|---|
| `SUPABASE_URL` | — (required) | Supabase project URL. |
| `SUPABASE_ANON_KEY` | — (required) | Supabase anon / publishable key; used only to check sign-in passwords. |
| `SUPABASE_SERVICE_ROLE_KEY` | — (required) | Supabase service-role key. Server only. |
| `REDIS_URL` | unset (in-memory cache) | Redis for the shared cache of Cloudflare reads. See [Cache](#cache). |
| `REDIS_PREFIX` | `backup-console` | Prefix of every Redis key. |
| `CONSOLE_ROLE` | `all` (`web` on Vercel) | `all`: this server does everything. `web`: UI and sign-in only; jobs go to the worker. `worker`: set by `npm run worker`. |
| `CONSOLE_ALLOWED_HOSTS` | any host | Comma-separated host names the console answers to (loopback always works); `*` allows any. |
| `CONSOLE_ORIGIN_SECRET` | unset (off) | Shared secret a Cloudflare Transform Rule sends; requests without it get 403. `new,old` while rotating. See CLOUDFLARE.md. |
| `CONSOLE_ORIGIN_HEADER` | `x-console-origin-auth` | Header that carries `CONSOLE_ORIGIN_SECRET`. |
| `CONSOLE_CLIENT_IP_HEADER` | last `X-Forwarded-For` hop | Header with the visitor's real address, for rate limits (`cf-connecting-ip` behind Cloudflare). |
| `CONSOLE_PUBLIC_URL` | unset | The console's public address: links in monitoring notifications, the Cloudflare alerts webhook, robots.txt and the sitemap (without it, the request's host), and absolute link-preview image URLs (read at build time). |
| `CONSOLE_DATA_DIR` | `./data` (a temporary folder on Vercel) | Where managed tools, the plugin cache, run folders and file records live. |
| `CONSOLE_STATE_MIRROR` | on (workers only) | `0` stops a worker copying file records (approvals, restore history) to Supabase `state_files`. |
| `CONSOLE_RELAY_TIMEOUT_MS` | `280000` | How long an API call on the web side waits for the worker. Behind Cloudflare keep it under 100 s (`90000`). |
| `CONSOLE_RELAY_CHUNK` | `524288` (512 KB) | Worker answers larger than this come back in chunks of this size. |
| `CONSOLE_WAKE_WAIT_MS` | `45000` | How long a request waits for a worker that is being started before it answers "starting". |
| `CONSOLE_VERSION` | unset | Version label for this deployment, used when `VERCEL_GIT_COMMIT_SHA` / `GITHUB_SHA` are not set. |
| `CONSOLE_WORKER_ID` | generated, kept in the data folder | Fixed worker id, for containers whose disk is fresh on every start. |
| `CONSOLE_WORKER_IDLE_MINUTES` | `0` (never) | The worker stops after this many idle minutes (the GitHub Actions workflow sets it). |
| `CONSOLE_WORKER_MAX_MINUTES` | `0` (never) | The worker stops after running this long, unless a job is running. |
| `CONSOLE_LISTEN_HOST` | `127.0.0.1` | Address `npm run worker` binds the server to (`0.0.0.0` for container platforms that probe the port). |
| `PORT` | `4400` | Port of the server `npm run worker` starts. |
| `VAULT_SERVER_KEY` | unset (key kept in Supabase) | Override for the vault server key. Set it on both sides or on neither. |
| `VAULT_SERVER_KEY_FILE` | — | No longer used; Settings › Environment warns while it is set. |
| `WORKER_GITHUB_TOKEN` | unset | Fine-grained GitHub token (Actions: Read and write) the web side uses to start the worker workflow. |
| `WORKER_GITHUB_REPO` | unset | `owner/name` of the repository with the worker workflow. |
| `WORKER_GITHUB_REF` | `main` | Branch the worker workflow runs on. |
| `WORKER_GITHUB_WORKFLOW` | `worker.yml` | Worker workflow file name. |
| `WORKER_GITHUB_API` | `https://api.github.com` | GitHub API base address (GitHub Enterprise). |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | unset (off) | Cloudflare Turnstile CAPTCHA on sign-in and setup; on only when both are set. |
| `RATE_LIMIT_SCALE` | `1` | Multiplies the general per-user rate limits (automated tests raise it). |
| `TRAFFIC_GQL_BUDGET` | `240` | Traffic analytics: GraphQL queries per window per Cloudflare token. |
| `TRAFFIC_GQL_WINDOW_MS` | `300000` | Length of that window. |
| `TRAFFIC_GQL_COOL_MS` | `300000` | How long a token waits once Cloudflare says its GraphQL budget is spent. |
| `TRAFFIC_DETAIL_ABANDON_MS` | `90000` | A traffic read nobody has polled for this long is stopped. |
| `MONITOR_BUDGET` | `800` (at least 20) | Monitoring calls per token per 5 minutes. |
| `MONITOR_PARALLEL` | `24` | Monitoring units running at once, over all tokens. |
| `MONITOR_TICK_MS` | `5000` | How often the monitoring queue looks for due units. |
| `MONITOR_NOTIFY_SECONDS` | `300` | Longest gap between notification batches while units run. |
| `CLOUDFLARE_BASE_URL` | `https://api.cloudflare.com/client/v4/` | Upstream of the read-only Cloudflare proxy that restore plans use (tests point it elsewhere). |
| `NEXT_PUBLIC_SALES_EMAIL` | `sales@example.com` (placeholder) | Where the landing page's "Contact sales" links go. Built into the page: rebuild after changing it. |
| `VERCEL`, `VERCEL_GIT_COMMIT_SHA` | set by Vercel | Detects Vercel (role `web`, temporary data folder) and the deployed commit. |
| `GITHUB_SHA` | set by GitHub Actions | The worker's version label. |
| `NODE_ENV`, `NEXT_RUNTIME` | set by Next.js | Standard Next.js variables. |

| `APPROVAL_TTL_MINUTES` | `30` | Minutes a pending approval stays valid before it expires. It is checked again when someone approves it and when it runs. |
| `CONSOLE_WORKER_ACCEPT_MINUTES` | none (`295` in worker.yml) | Minutes after the worker job started during which new backups and applies are accepted. After that the worker finishes what runs and hands over, well before GitHub's 6-hour limit. |
| `CONSOLE_WORKER_JOB_STARTED_AT` | process start | When the worker job started (ms). worker.yml and `scripts/worker.mjs` set it; you don't. |
| `RELAY_SIGNING_KEY` | derived from the vault server key | Optional key (at least 32 characters) that signs relayed calls. Set the same value on Vercel and the worker (GitHub secret of that name). |
| `RATE_LIMIT_STORE` | Redis when `REDIS_URL` is set; Supabase on Vercel/web role; else memory | Forces where rate-limit and sign-in counters are kept: `redis`, `supabase` or `memory`. Shared stores need migration 0014. |
| `RAY_MAX_QUERIES` | `60` (at most 200) | Most GraphQL queries one Ray ID lookup may make when no zone is given (Investigate). |
| `ZONE_SEARCH_BUCKET_RPM` | `600` (at least 30) | Most bucket requests per minute while the search index is rebuilt from backups. |
| `DNS_HEALTH_DOH` | on | `off` stops the DNS hygiene check's public lookups (DNS over HTTPS to 1.1.1.1). |
| `DOH_URL` | `https://cloudflare-dns.com/dns-query` | The DNS-over-HTTPS resolver the DNS hygiene check and onboarding use. |
| `REPORTS_TICK_MS` | `60000` | How often the worker looks for scheduled reports that are due. |
| `SLACK_SIGNING_SECRET` | none (the Slack command is off) | The Slack app's signing secret; requests to `/api/hooks/slack` are verified with it. |
| `SLACK_COMMAND` | `/castellan` | The slash command name, as set up in the Slack app. |
| `SLACK_TEAM_ID` | any workspace | Only accept commands from this Slack workspace. |

<!-- END env-table -->

`backup.js` reads these (the console sets the credential ones from the vault for each run; run by hand, it also loads a `.env` next to itself):

| Variable | Default | Meaning |
|---|---|---|
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | empty | Cloudflare API token and account id. |
| `ZONE_STATUS_FILTER` | `all` | Only zones with this status. |
| `BACKUP_REQUIRE_UPLOAD` | on under GitHub Actions, else off | `1` refuses to start without an R2 or S3 destination (on the worker the local copy disappears when the job ends); `0` never requires one. |
| `ZONE_STATUS_EXCLUDE` | `moved` | Space-separated statuses to skip. |
| `ZONE_NAME_FILTER` | `*` | Shell glob on the zone name. |
| `ZONE_IDS` | empty (every zone) | Space- or comma-separated zone ids. |
| `BACKUP_ACCOUNT` | `auto` | Account-level resources: `auto`, `true` or `false`. |
| `BACKUP_MODE` | `generate` | `generate`, or `import` to also write `imports.tf`. |
| `OUTPUT_DIR` | `$HOME/cf_backups` | Where backups are written. |
| `AUDIT_LOG_HOURS` | `72` | Hours of Cloudflare audit log saved with a backup. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_PREFIX` | empty | R2 upload credentials, endpoint and key prefix. |
| `R2_BUCKET_NAME` | `terraform-backup` | R2 bucket. |
| `R2_SKIP_UPLOAD` | `true` | `false` uploads to R2. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | empty | S3 upload credentials. |
| `AWS_S3_BUCKET` | a name built into `backup.js` | S3 bucket. |
| `AWS_REGION` | empty (looked up) | S3 region. |
| `AWS_SKIP_UPLOAD` | `true` | `false` uploads to S3. |
| `TF_PLUGIN_CACHE_DIR` | the console's plugin cache | Terraform provider cache. |
| `HOME`, `PATH` | from the system | Used to find tools and the default output folder. |

## Vercel + worker

On Vercel the console runs as the **web** side: sign-in, pages, users and the audit log. Vercel can't do the rest: its disk is read-only, functions stop after a few minutes, and its outgoing IP changes. So everything else goes to a **worker**: backups, restores, tool installs, the vault and every Cloudflare, R2 and S3 call. The worker is the same console, started with `npm run worker` on a machine or container you control.

```text
browser ──► Vercel (CONSOLE_ROLE=web) ──► Supabase: worker_calls (sealed) ◄── worker (npm run worker) ──► Cloudflare / R2 / S3
```

- **How a call travels**:
  1. The web side checks the session, the role and the rate limits.
  2. It queues the request in `worker_calls`, sealed with AES-256-GCM under the vault server key and signed with the caller's identity.
  3. The worker claims it, replays it on its own server over loopback, and writes the answer back, also sealed. Large answers such as downloads come back in 512 KB chunks.
  4. The web side reads the answer and deletes the row.

  The worker trusts a replayed request only with a valid signature, for that exact method and path, before it expires.
- **No inbound access**: the worker only connects out (Supabase, Cloudflare, R2/S3, the Terraform release site). It needs no public URL, open port or tunnel.
- **Cloudflare token IP restrictions**: every Cloudflare call comes from the worker.
  - **On GitHub Actions** (the default below): the outgoing IP changes with every run, so the console's Cloudflare API tokens must **not** be restricted to client IPs.
  - **On a machine with a fixed IP**: **Settings › Worker** shows its public IP, and you can restrict tokens to it.
- **Live logs**: the worker writes each run's log to Supabase as it goes. The run page on Vercel follows it there and reconnects every few minutes.
- **Worker offline**: a banner on every page says so. Backups, restores, the vault and Cloudflare pages answer "The worker is offline". Sign-in, users and the audit log keep working.

### Deploy to Vercel

1. Apply all the migrations above (`0001` to `0021`).
2. In the Vercel project, set `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. `CONSOLE_ROLE=web` is the default on Vercel.
3. Deploy. [`vercel.json`](vercel.json) gives API routes up to 300 s, so a slow call such as a full zone read can wait for the worker.

### Start the worker on GitHub Actions (free, recommended)

The worker runs as a GitHub Actions job: [`.github/workflows/worker.yml`](.github/workflows/worker.yml), the **Console worker** workflow. You need no server, no Docker and no paid plan. Public repositories get unlimited Actions minutes; private ones get 2,000 a month.

How it runs:

- **Starts when needed**: when someone opens the console and no worker is running, Vercel asks GitHub to start it. It does the same when a page needs the worker.
- **Startup**: a runner takes about 2–3 minutes to come up. It installs and builds the console, then downloads Terraform and cf-terraforming (cached between runs). Meanwhile, every page shows **Starting the worker…**.
- **Stops when idle**: it stops itself after **20 idle minutes**. Using the console counts as activity; an open tab's background status polls don't, and they don't start a stopped worker again either (the next click or page load does). It never stops during a backup, a restore or an open restore session, or while monitoring units run.
- **Hands over before GitHub's 6-hour limit**: after `CONSOLE_WORKER_ACCEPT_MINUTES` (295) it refuses new backups and applies with "try again in a minute", finishes what runs, saves pending writes and exits. A new run never cancels a running one (`cancel-in-progress: false`), and the console doesn't start a second run while one is queued or running. A worker that stops without retiring counts as offline after 3 minutes without a heartbeat.
- **Several consoles, one Cloudflare account**: backups and restores take a lock row in Supabase (`job_locks`, migration 0013) per Cloudflare account, so a laptop console and the worker can't work on the same account at once. Approvals are carried out once (`approval_states`) and expire after `APPROVAL_TTL_MINUTES`.
- **One at a time**: one worker runs at a time.
- **What lasts between runs**: approval requests and restore history are kept in Supabase. The vault unlock and run folders behind **Download** last for one worker session; backups uploaded to R2 or S3 stay there.
- **Token IP restrictions**: GitHub's runners have a different IP on every run, so the console's Cloudflare API tokens must not be restricted to client IPs.

Set up:

1. **Apply the migrations.** All of them, `0001` to `0021` (see [Set up](#set-up)).
2. **Add repository secrets.** In GitHub › the repository › **Settings › Secrets and variables › Actions**, add `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`, with the same values as on Vercel. Optionally add `REDIS_URL`.
3. **Create a token Vercel can use to start the workflow.** In GitHub › your avatar › **Settings › Developer settings › Personal access tokens › Fine-grained tokens › Generate new token**:
   - **Repository access:** only this repository.
   - **Permissions:** **Actions: Read and write**. Nothing else is needed.
4. **Add Vercel environment variables.** In Vercel › the project › **Settings › Environment Variables**, add:
   - `WORKER_GITHUB_TOKEN`: the token from step 3.
   - `WORKER_GITHUB_REPO`: `owner/name`, for example `aaydee99/zone-analyser`.
   - Optionally `WORKER_GITHUB_REF`, the branch to run (default `main`), and `WORKER_GITHUB_WORKFLOW` (default `worker.yml`).

   Redeploy Vercel after adding them.
5. **Push and test.** Push the repository, including `.github/workflows/worker.yml`, then open the console. The banner shows **Starting the worker…**, and within about 3 minutes **Settings › Worker** shows it **online**. You can also start it by hand under **Actions › Console worker › Run workflow**, and watch its log there.

### Or start the worker on your own machine or server

Use this to restrict Cloudflare tokens to one fixed IP. Put the same three Supabase variables in `.env.local` there.

- **With Node.js 20.9 or newer** (Windows, macOS or Linux): copy the project, then run `npm run worker`. It installs the dependencies, builds the console if the source changed, starts it on `127.0.0.1:4400`, and restarts it if it stops. On first start it downloads Terraform and cf-terraforming, checksum-verified.
- **With Docker** (any machine): `docker compose up -d --build`. The tools and backups are kept in the `worker-data` volume.
- **To keep it running after a reboot**: Docker's `restart: unless-stopped` does this. Without Docker, start `npm run worker` as a service (Task Scheduler or NSSM on Windows, systemd on Linux, launchd on macOS).

Never set `VAULT_SERVER_KEY` on only one side. Both sides must use the key in Supabase, or the same override.

Running one worker is the normal setup. With several, each call is still handled exactly once, but a backup or restore and its follow-up calls may land on different workers, and a run started on one is only visible on that one while it runs.

The first super admin: on Vercel the setup token is printed in the function log (Vercel › Logs), because `data/` there is temporary.

## Roles

| | Viewer | Operator | Admin | Super admin |
|---|:-:|:-:|:-:|:-:|
| Run history, live logs, backup files, download .zip | ✓ | ✓ | ✓ | ✓ |
| **Zone explorer**: full read-only zone configuration, downloads | ✓ | ✓ | ✓ | ✓ |
| Start / cancel backups, **use presets** | | ✓ (start needs an admin's approval) | ✓ | ✓ |
| **Approve or reject** operator backups | | | ✓ | ✓ |
| Save / delete presets | | ✓ | ✓ | ✓ |
| Delete runs, settings, managed tools, audit log, recent changes, Cloudflare activity | | | ✓ | ✓ |
| Restore a zone's changed configuration from a backup (plan, then apply) | | | ✓ (apply needs a super admin's approval) | ✓ |
| **Approve or reject** admin restore applies | | | | ✓ |
| Manage operators and viewers | | | ✓ | ✓ |
| Manage admins and super admins | | | | ✓ |
| **Monitoring**: see findings and results (Tokens & members: admins and super admins only) | ✓ | ✓ | ✓ | ✓ |
| **Monitoring**: run checks now, dismiss findings, accept drift, set up notifications | | | ✓ | ✓ |
| Connect Cloudflare's own alerts (Monitoring › Cloudflare alerts) | | | | ✓ |
| **Cache purge**, **roll back** a Worker or Pages deployment | | | ✓ (needs a super admin's approval) | ✓ |
| **Approve or reject** admins' cache purges and rollbacks | | | | ✓ |
| **Search**, **Compare**, **Investigate** (Ray ID, URL trace, WAF false positives, timeline), **Security audit** (run and read), **Zone health**, **IP & ASN lists**, **Logpush** status, **Zone onboarding**, **Reports**: read-only | ✓ | ✓ | ✓ | ✓ |
| **Zone tags**, owners and comparison templates: set and change (`zones:tag`) | | | ✓ | ✓ |
| **API console** and live **Worker logs** with the stored tokens (`cloudflare:query`) | | | ✓ | ✓ |
| **Logpush** job changes | | | ✓ (needs a super admin's approval) | ✓ |
| Make reports and schedule them; rebuild the search index | | | ✓ | ✓ |
| **Revert a change** from Cloudflare activity | | | | ✓ + Global API Key |
| Choose upload on/off and the bucket for a run, from the buckets approved on the credential | | ✓ | ✓ | ✓ |
| **Credential vault** (view, add, edit, reveal, test, import): also decides **which buckets** uploads may go to, and the prefix, region and R2 lock rules | | | | ✓ + vault password |

Roles are enforced on the server for every request ([`src/lib/rbac.ts`](src/lib/rbac.ts)). The UI only hides what a role can't use. Role changes take effect immediately. Disabling, demoting or resetting a user's password signs them out everywhere. The last super admin can't be removed, disabled or demoted.

### Approvals

- **Operator backups:** **Start backup** becomes **Request backup**. The request is checked exactly like a start (account set, buckets, output folder), so an approver only sees requests that can run. Nothing runs until an **admin or super admin** approves it under **Approvals**; approving starts the backup at once and the operator's page opens the run by itself. Admins and super admins start backups directly.
- **Admin restores:** comparing and planning are unchanged. **Apply** becomes **Ask a super admin to apply**: the zone name, the replace/delete confirmation and the Global API Key are all checked first, then the plan is locked until a **super admin** decides. Approving starts the apply at once. The Global API Key is held **in the console's memory only** until then — never on disk, in the database, the audit log or the request — and dropped when the request is decided, withdrawn or expires. The request expires with the plan (30 minutes); after a console restart the key is gone and the admin applies again. Super admins apply directly.
- **Reject and withdraw:** an approver can reject with a reason the requester sees; the requester can withdraw a request that is still waiting. Nobody decides their own request.
- **When something is already running:** approving while another backup or restore runs is refused and the request stays waiting — approve it when the job finishes.
- **Where it shows:** **Approvals** in the sidebar (with a count of requests waiting for you), the request on New backup / New restore, "Requested by … · approved by …" on the run page, and the steps of the restore in Restore history.
- **Audit log:** `approval.requested`, `approval.approved`, `approval.rejected` (with the reason), `approval.withdrawn`, `approval.expired`, `approval.failed`; `run.started` and `restore.apply_started` name who approved them. Approvals and rejections are also listed under **Recent changes › Approvals**.
- **Stored:** one record per request in `data/approvals/<id>.json`. API: `GET /api/approvals`, `GET /api/approvals/{id}`, `POST /api/approvals/{id}/approve | reject | withdraw`.

**Viewer is a trusted role.** Viewers see full backup contents, which is the whole Cloudflare configuration of the account, plus the live logs.

### Uploads: on/off and which bucket

Credentials are **account sets**: one vault entry holds a Cloudflare account (API token + account ID) together with the storage its backups go to — an optional **Cloudflare R2** section and an optional **AWS S3** section. Either can be left empty, but storage never exists on its own, so one account's backup can never be sent to another account's bucket, and a restore only reads from the set's own buckets.

**Leave the account ID empty** to use every account the API token can access. The console asks Cloudflare which accounts that is (`GET /accounts`, kept for 5 minutes), and then:

- **Test** checks the token and lists those accounts and the zones it can see.
- **Zone pickers** (backup, restore) list the zones of all of them, each labelled with its account.
- **A backup** runs `backup.js` once per account, one after the other, in one run with one log. Each account gets its own backup folder, named after the account. With chosen zones, only the accounts those zones are in are backed up. The run fails if any account fails, and the log ends with which ones.
- **Cloudflare activity** and **Revert** read the audit log of every account.
- **A restore** uses the account the zone belongs to.

All of an empty-ID set's backups go to its own buckets. For different buckets per account, make one set per account with its account ID.

On **New backup** you pick the account set. *Upload to Cloudflare R2* and *Upload to AWS S3* are ON/OFF switches (`R2_SKIP_UPLOAD`, `AWS_SKIP_UPLOAD`); a switch is disabled when the set has no such storage. With an upload on, you choose:

- **The bucket.** The choices are the set's **default bucket** plus its **other approved buckets** for that storage. Only a super admin edits these in Credentials.
  - **Find buckets** in the account-set editor lists the buckets the keys can see (S3 `ListBuckets`). Click one to approve it, click again to remove it.
  - R2 keys are only ever sent to an R2 endpoint, and AWS keys to Amazon's own S3 address.

**The server enforces it:**
- Upload keys come only from the run's account set; a request naming any other storage credential is ignored.
- A run, or a saved preset, naming a bucket that isn't approved on its account set is refused — including another set's bucket.
- A section is saved all-or-nothing: a half-filled R2 or S3 section is refused. "Remove Cloudflare R2 / AWS S3" in the editor clears one.
- Endpoint, prefix and R2 lock rules always come from the account set.
- For AWS, the credential's region applies to its default bucket; any other bucket's region is detected automatically.

The run record and the audit log show which bucket was used, and "run again" reuses it.

## Vault

- **Access**: only super admins can open the vault, and only after entering the **vault password**. Choose one different from your sign-in password. The console doesn't check this, because checking would mean sending the vault password to Supabase Auth. The vault locks itself after an idle period (Settings › Sessions) or when you sign out.
- **Vault server key, in Supabase**: backups decrypt credentials with the vault server key, so they never need the vault password and never depend on the vault being locked or unlocked. The key is kept in Supabase (`public.vault_keys`, row-level security on, readable only with the service-role key) and created on first use; there is no key file. `VAULT_SERVER_KEY` in `.env.local` still overrides it, and `VAULT_SERVER_KEY_FILE` is no longer used.
- **The trade-off**: whoever has the Supabase service-role key can read both the vault server key and the vault, so they can decrypt every credential. Keep the service-role key secret.
- **Moving from a key file**: remove `VAULT_SERVER_KEY_FILE` from `.env.local`, apply `0003_vault_server_key.sql`, restart, and unlock the vault once with the vault password. The console re-wraps its server copy under the key in Supabase (`vault.server_key_resealed` in the audit log). Until then, backups say a super admin must unlock the vault once.
- **Encryption**: all credentials are encrypted with one random 256-bit data key (AES-256-GCM, each sealed with its own id). Supabase only ever stores ciphertext. The data key is stored in two wrapped copies:
  - `dek_pw`: wrapped with scrypt (N=2¹⁷) of the vault password. Opens the vault UI.
  - `dek_server`: wrapped with the vault server key. Used only inside the server process when a backup runs, so operators can run backups and presets without the vault being opened. Secrets are put into the `backup.js` process environment and replaced with `••••••••` in every log line. No API ever returns them to anyone except a super admin with the vault unlocked.
- **Lost or changed server key**: if the key in `vault_keys` is deleted or changed, a super admin unlocks the vault once with the vault password and the server copy is re-wrapped automatically. If both the server key and the vault password are lost, the credentials can't be recovered.
- **Reset the vault password** (lost or to be replaced), keeping every credential:
  1. Run [`supabase/maintenance/reset_vault_password.sql`](supabase/maintenance/reset_vault_password.sql) in the Supabase SQL editor. It clears only the password copy of the data key (`dek_pw` and its salt). The credentials and the server-key copy stay, and it refuses to run if the server-key copy is missing.
  2. Open **Credentials** as a super admin. It asks for a new vault password.
  3. The console opens the data key with the server key and wraps it under the new password. Nothing is re-entered, and backups keep running throughout.

  The console needs the same server key the vault was created or last re-sealed with. The audit log records `vault.password_cleared`, then `vault.password_reset`.
- **Audit**: every reveal, test, create, edit and delete is recorded in the audit log.
- **Older separate R2 / AWS entries** (saved before account sets) show as *legacy*. They can't be created or used for runs any more; **Move into a set** copies one into an account set on the server (its secrets are never shown or retyped) and can delete the old entry. **Import .env** creates one account set per file.

## Restore

Restore has its own section in the sidebar, set out like Backups:

- **Restore › Overview** (`/restore`): a dashboard: when a restore was last applied, the success rate, how many restores were verified against the backup, the last 30 days, the restore running now (or the latest one), restores per day for 30 days by outcome, recent restores, recent backups and a set-up checklist.
- **Restore › Restore history** (`/restore/history`): every restore with its outcome (applied · verified, applied · not verified, apply failed, plan failed, open, not applied, interrupted), filterable like Run history. Each one opens a page with its steps, the plan it applied (addresses and actions), the backup it used and its full log. A record is kept per restore in `data/restore-history/<id>.json` and updated at every step; it holds no token, key or attribute values. Restores from before these records are listed from the audit log. API: `GET /api/restore/history`, `GET /api/restore/history/{id}`.
- **Cancelling a restore:** while a restore compares, plans or applies, **Cancel** (New restore) stops terraform and the Cloudflare provider with their whole process tree, and no further step starts (`POST /api/restore/{id}/cancel`, recorded as `restore.cancelled`). A cancelled compare or plan goes back to where it was — nothing was changed, compare or plan again. A cancelled apply is not undone: changes Terraform had already sent to Cloudflare stay, the restore shows **Apply cancelled**, and planning again shows what is left. Cancelled after Terraform finished applying (during the check), it counts as applied but not verified.
- **Restore › New restore** (`/restore/new`) puts one zone back the way its latest backup has it: only what the audit log says changed, or — with **Compare everything** — the whole zone, exactly as backed up. It's for admins and super admins (the `restore:run` permission).

1. **Pick the source.** Choose the Cloudflare account and zone, and where backups live (an R2 or S3 credential and approved bucket).
2. **Find the backup and the changes.** The console:
   - lists the backup folders (`<prefix>/<Account>_<YYYYMMDD_HHMMSS>/`) and takes the **newest one that contains the zone**, saying if newer folders were skipped because they don't contain it;
   - downloads that zone's `.tf` files (the backup's own `imports.tf` is ignored);
   - reads the zone's Cloudflare audit log **since the backup was taken**, keeping only configuration changes (creates, updates, deletes). Views and other reads (backup runs, lookups), failed requests and cache purges are ignored; the page lists what was ignored.
3. **Match each change to its backup block.** Matching uses the Cloudflare ID in the block label (`terraform_managed_resource_<id>_N`), the `setting_id` for zone settings, or the phase for rulesets. Each change becomes one of:
   - **Revert to backup:** it still exists, so it's imported and set back to the backup values.
   - **Re-create:** it was deleted after the backup, so it's created from the backup. If it was already created again under a new ID with the same name and type, that object is imported instead, so it's never duplicated.
   - Anything the backup does not cover is disregarded: audit-log changes with no block in the backup (account-level changes, types that weren't exported) are not shown. A creation of a type the backup has becomes a delete in the comparison (below).
3b. **Compare with the live zone (runs on every "Find latest backup & compare", and on "Compare again").** The audit log can miss changes, and still lists changes that were already restored, so the page always checks the live zone itself, read-only, and only shows what differs now:
   - every block of the backup is imported and planned against the live zone (`terraform plan -json`). Each resource shows as **differs** (field by field, live → backup), **deleted** (its import fails as non-existent → re-create), **matches**, or **could not be checked** (with Terraform's reason);
   - the live zone is listed with cf-terraforming for the resource types the backup has (rulesets through the API). Anything live of those types that the backup does not have is offered as **Delete (not in backup)**, selected. Types the backup has none of are not listed at all;
   - **Email Routing on/off** is compared with the backup's API snapshot (`account/api_backup/zone_<zone>/email_routing_settings.json`). Terraform cannot set it (`cloudflare_email_routing_dns` reads back empty and its update fails on the apex), so those blocks are never planned; when it differs it is planned **via API** and set at apply (`POST`/`DELETE /zones/<id>/email/routing/dns`) with the same Global API Key;
   - an error that names no resource (a provider error with only a URL) is narrowed down by planning the imports in halves, so it marks only the resources that cause it;
   - a deleted backup object that was created again under a new ID (same name and type, one unambiguous match) is imported and reverted, not deleted and duplicated.
   Everything found is selected, so **Plan** then **Apply** puts the zone back exactly as backed up. Deletes are planned by importing the live object into the Terraform state with no config block; the apply then needs the "replaces or deletes" box ticked.
4. **Plan.** You tick what to restore. A Terraform folder gets **only those blocks** (plus any block they reference) and `import` blocks for the ones that exist. `terraform init` and `terraform plan -out` run, and the plan is shown field by field (live value → backup value). Planning only reads from Cloudflare: every plan (and compare, and the post-apply check) runs through a local read-only guard set as `CLOUDFLARE_BASE_URL`. It passes reads through and never sends a write. That matters because provider 5.28.1 sends `PUT /rulesets/<id>` during `terraform plan` when a ruleset is imported, which would otherwise change live WAF rules before anyone approved anything. A refused write is answered with the current live state and noted in the log.
5. **Apply.** You type the zone name to confirm (and tick a second box if the plan replaces anything), and enter the **Cloudflare account email and Global API Key** — asked for at every apply. The key is checked against the zone with Cloudflare first, used only for that apply's Terraform run (`CLOUDFLARE_EMAIL` / `CLOUDFLARE_API_KEY`), and never stored, logged or returned; the audit log records which email's key was used. The console applies **exactly the saved plan**, then runs one more plan to confirm nothing is left to change. Plans expire after 30 minutes. "Provider produced inconsistent result after apply" (Cloudflare accepted the write but reads an attribute back as null — a provider bug, e.g. `bot_management.bot_preference_sync_enabled`) is a warning, not a failure, and that attribute is ignored by the check.

**Limits:**
- **Credentials:** the stored Cloudflare token reads the audit log and makes the plan (read-only is enough). The apply always uses the Global API Key typed in for it, so that user must be able to edit the zone.
- **Granularity is one Terraform resource:** a zone setting, a DNS record, or a whole ruleset phase. Restoring WAF custom rules restores that phase's whole rule list to the backup.
- **Scope:** zone-level configuration only, and only what the backup has. Zero Trust (`cloudflare_zero_trust_*`, including zone-scoped Access) and account-level blocks are left out entirely; account-level audit changes are not shown. Backed-up types the token cannot list live are named on the page; additions of those types are not found or deleted.
- **Provider version:** the backup's `provider.tf` pins the provider to `~> 5.0`, so `terraform init` downloads the newest 5.x the first time.
- **One job at a time, console-wide:** while a backup runs, or a restore is comparing, planning or applying, starting any other backup or restore step is refused (by the server, not just the page). Every page shows the running job in the sidebar, and refreshing the Restore page brings back the running restore (or the one that tab had open) with its pickers and live log.
- **Provider quirks:** some values the Cloudflare provider reads back differ from how they are written though they mean the same, so they would show as changed forever. They are fixed at both ends:
  - **Backup:** `bot_management.bot_preference_sync_enabled` (accepted, never returned) is not written, and `cloudflare_email_routing_dns` is not exported (Email Routing on/off is kept in the API snapshot); DNSSEC transitional states are written as the state they lead to.
  - **Restore:** a fixed list in `restore-hcl.ts` (`PROVIDER_EQUIVALENT`) treats these as equal — DNSSEC `pending` = `active` and `pending-disabled` = `disabled`; schema validation unset = `"none"`; snippet `metadata` not returned; `bot_preference_sync_enabled` not returned (older backups). Real changes still count (DNSSEC `disabled` vs `active` is always a difference). Computed attributes the backup does not set (DNSSEC `ds`/`digest`, bot management `sbfm_*` …) never count. Anything else still different after an apply fails the check.
- **Sessions:** Sessions are kept in memory for two hours (restarting the console clears them), with working folders in `data/restores/`.
- **Audit:** every step is recorded in the console's audit log (`restore.prepared`, `restore.compared`, `restore.planned`, `restore.apply_started`, `restore.applied` / `restore.apply_failed`).

## Recent changes

**Access › Recent changes** turns the audit log into a list of what changed over the last 24 hours, 7 days (default) or 30 days. Each change is one line, such as "Changed op@example.com: role operator → viewer" or "Added R2 credential “Backups”". The list is grouped by day and can be filtered by area: users, credentials and vault, presets, settings and tools, runs, accounts.

The page also shows who made the changes and counts the rest of the activity: sign-ins, failed sign-ins, backups started, vault unlocks and revealed secrets. **Copy summary** copies the whole report as plain text. API: `GET /api/audit/changes?days=7` (1–30, admins and super admins only).

## Cloudflare activity

**Cloudflare › Cloudflare activity** reads each account's Cloudflare audit log and shows what changed. Each change shows its account, zone, category, exactly which fields changed, and the old and new values.

- **Period:** the last 24 hours, 7 days, 30 days or 12 months, or custom dates (whole UTC days, inclusive). Cloudflare keeps 18 months of audit logs.
- **Categories:** Zone onboarding, DNS changes, Security rule changes, CDN & cache rule changes, Redirect/transform/origin rules, SSL/TLS & certificates, Zone settings, Load balancing & traffic, Zero Trust, Workers & developer platform, Members/roles/API tokens, Logs, Email, Billing.
  - Changes are sorted mainly by the API path that was called. Rulesets are sorted by their phase, using Cloudflare's [Ruleset Engine phase list](https://developers.cloudflare.com/ruleset-engine/reference/phases-list/): for example, `http_request_firewall_custom` is Security and `http_request_cache_settings` is CDN & cache. Zone settings are sorted by setting name.
  - Cloudflare's own product category (from `GET /accounts/{id}/logs/audit/product_categories`) is shown on each change and used as the fallback.
  - The rules live in [`src/lib/cf-classify.ts`](src/lib/cf-classify.ts).
- **Old → new values:**
  - Each update shows the fields that changed, old and new. For rulesets this goes rule by rule, for example `rules[block bad bots].action: log → block`.
  - Creations show the new values; deletions show the last known values.
  - The old value is the state left by the previous change to the same resource. When that change is before the selected period, **Look up old values** asks Cloudflare's Resource History (`GET /accounts/{id}/logs/audit/{id}/history`).
  - A failed change is marked as rejected, and doesn't count as the resource's state.
- **Zone onboarding:** zones added, activated or removed during the period.
  - **Added** and **activated** come from the zone list (`created_on`, `activated_on`).
  - **Removed** and **who did it** come from the audit log.
  - If a token can't list zones, additions come from the audit log only, and the page says so.
- **Views and tools:** by category, by account & zone, or a timeline. There's a filter for zones, fields, values or people, and a category filter. **Copy summary** copies the report as text; **CSV** exports one row per changed field, with old and new values.
- **Limits:** a report reads at most 5,000 changes per account and 10,000 in total. When it hits the cap it says so; choose a shorter period to see everything.
- **Only changes are read:** the console asks Cloudflare to leave out views, `GET`/`HEAD` reads and failed requests (`action_type.not=view`, `raw_method.not`, `action_result.not=failure`), so the limit counts real changes. A backup run reads the whole account and leaves thousands of view entries; counted against the limit, they would cut every period down to about the last day. Restore reads changes since the backup the same way.

**Token permissions:**
- **Account Settings: Read** for audit logs, categories and Resource History.
- **Zone: Read** for onboarding dates.

A token missing either is named with the permission it needs.

**Access:** admins and super admins only. Tokens are decrypted on the server and never sent to the browser. Secret-looking fields are masked. Every report viewed is recorded in the console's audit log as `cloudflare_audit.viewed`.

### Reverting a Cloudflare change

Super admins see **Revert** on each change in Cloudflare activity. Reverting goes through the same API endpoint the change used:

| The change | Reverting it |
|---|---|
| Created (`POST` to a list) | Deletes it (`DELETE` on the new item) |
| Updated (`PATCH` / `PUT`) | Sends the old values of exactly the fields the change set |
| Deleted | Creates it again from its old state (`POST` to the list). It gets a **new id**. |

- **Old state:** taken from Cloudflare Resource History (the state after the previous change to the same resource). If Cloudflare has no earlier state, the change can't be reverted here. For a deleted object that's in a backup, use Restore.
- **Review first:** the console works out the request with the stored read-only token and shows it exactly: method, path and JSON body. Nothing is sent until you enter the Cloudflare account email and **Global API Key** and press **Send to Cloudflare**. The key is checked against the zone (or account), used for that one request, and never stored, logged or returned.
- **Sends what you reviewed:** when you send, the request is worked out again. If it no longer matches what you reviewed, the console refuses and asks you to review it again.
- **Changed since:** if the resource was changed again after the entry, the review says so, and you must tick **Revert anyway** (which also undoes those later changes).
- **Already gone or already back:** a revert is refused when the item was already deleted, already has the old values, or exists again.
- **Each entry once:** a successful revert is recorded as `cloudflare.reverted` (with whose key was used), and the same entry can't be reverted again. The revert itself shows up in Cloudflare's audit log as a new change, which can in turn be reverted.
- **Not reverted:**
  - zones and accounts themselves, members, API tokens, roles, billing and registrar;
  - cache purges;
  - Worker and Pages deploys (the audit log doesn't keep the code);
  - certificates and keys;
  - failed changes;
  - changes whose old values include secret or masked fields. Secret fields in an update are skipped, and the review lists them.
- **One job at a time:** refused while a backup or restore is running.
- **API:** `POST /api/cloudflare-audit/revert/plan` `{accountId, entryId, time}` returns the request without sending it (30 a minute). `POST /api/cloudflare-audit/revert` `{…, planHash, email, apiKey, acknowledgeChangedSince?}` sends it (10 a minute).

**API:**
- `GET /api/cloudflare-audit?credentialId=all|<id>&range=day|week|month|year|custom[&since=YYYY-MM-DD&before=YYYY-MM-DD]`
- `GET /api/cloudflare-audit/history?accountId=&id=&time=`

## Zone explorer

**Cloudflare › Zone explorer** shows everything the stored Cloudflare tokens can read about any zone, in any account they can reach. It's open to **every role**, it's **read-only** (the console sends Cloudflare only `GET` requests here), and you can download what it reads.

- **Zones:** every stored Cloudflare token lists the zones it can reach (`GET /zones`, across all accounts). Zones are grouped by account and searchable. If a token can't list zones, the page says so ("Zone: Read" is needed). The list is kept for 5 minutes; **Refresh zones** lists them again.
- **Current APIs only:** everything comes from Cloudflare's official API reference (the OpenAPI schema at [cloudflare/api-schemas](https://github.com/cloudflare/api-schemas), which Terraform provider v5 and Cloudflare's v5 SDKs are generated from).
  - Nothing the reference marks **deprecated** is read. That leaves out the bulk `/settings` endpoint, the legacy firewall APIs (filters, firewall rules, rate limits, WAF packages and overrides), and five deprecated settings: `cname_flattening`, `mirage`, `orange_to_orange`, `privacy_pass` and `response_buffering`.
  - The endpoint list, setting ids and rule phases are in [`src/lib/zone-catalog.ts`](src/lib/zone-catalog.ts). A test checks them against the official schema.
- **One zone, in full:**
  - **110 endpoints:** the zone-scoped `GET`s that need only the zone id.
  - **Zone settings:** 62, read one by one with `GET /settings/{setting_id}`. Settings the plan or token can't read are named, with Cloudflare's reason.
  - **Rule pages:** 19, read with `GET /rulesets/phases/{phase}/entrypoint`.

  The page, the CSV and the JSON show everything in this order:

  | # | Section | What's in it |
  |---|---|---|
  | 1 | Zone settings | zone details, subscription, hold, general settings (AI crawler and agent settings) |
  | 2 | DNS | records, DNS settings, DNSSEC, record usage, secondary DNS |
  | 3 | Email | Email Routing settings, DNS, rules and catch-all, DMARC reports |
  | 4 | SSL / TLS | SSL/TLS settings (mode, minimum TLS, TLS 1.3, Always Use HTTPS, HSTS …), edge and custom certificates, Authenticated Origin Pulls, custom hostnames, mTLS |
  | 5 | Security rules | Custom rules, Rate limiting rules, Managed rules, Super Bot Fight Mode, response rules, HTTP DDoS overrides, IP Access rules, User Agent blocking, Zone Lockdown |
  | 6 | Security settings | security level, challenge passage, browser integrity check, Scrape Shield, Bot Management, Page Shield, leaked-credential checks, content scanning, security.txt |
  | 7 | Speed settings | Brotli, Early Hints, Rocket Loader, Polish, WebP, image transformations, HTTP/2, HTTP/3, 0-RTT, APO, Fonts, Speed Brain |
  | 8 | Cache settings | caching level, browser and edge cache TTL, Always Online, development mode, tiered cache, Cache Reserve, variants |
  | 9 | Cache rules | Cache Rules, Cache Response Rules |
  | 10 | CDN rules | Redirect Rules, URL Rewrite, Request/Response Header Transform, Origin, Configuration, Compression and Custom Error Rules, URL normalization, Logpush custom fields, Page Rules, Managed Transforms, Snippets, Cloud Connector, custom error pages |
  | 11 | Network settings | IPv6, WebSockets, IP geolocation, Pseudo IPv4, True-Client-IP, maximum upload size, Onion Routing, Network Error Logging, HTTP/2 to origin, Argo Smart Routing |

  After those come the parts that aren't settings or rules: Traffic & load balancing, Workers & Zaraz, API Shield, zone-level Zero Trust, Logs, and the full list of rulesets (including managed ones).

- **Rules, as in the dashboard:** each rule page lists its rules in order, with name, match expression, action, what the action does and whether it's enabled. Pages with no rules show "none".

  "What it does" spells out the action, for example:
  - a redirect's status code and target;
  - a rewrite's path, query and headers;
  - an origin rule's host, port and SNI;
  - a rate limit's requests per period, what it counts by, and how long it blocks;
  - which managed ruleset an "execute" rule runs, by name.

  Account-level phases (Bulk Redirects, Magic Transit, network-layer DDoS) aren't zone rule pages.
- **Certificates:** the SSL / TLS card opens with one table of every certificate: edge certificate packs (each certificate in a pack), uploaded custom certificates, custom hostnames, Authenticated Origin Pulls certificates, mTLS client certificates and the custom origin trust store. Each row says whether it is **Cloudflare managed** (Universal SSL, Advanced certificates, Total TLS, Cloudflare-issued custom hostname and mTLS certificates) or **Custom** (uploaded certificates and keys, your own CA). It also shows the hosts, issuer, status, expiry date and days left, soonest expiry first; expired ones are red and those expiring within 30 days amber. A certificate listed twice (an uploaded certificate also appears as its certificate pack) is shown once. The table is built from the SSL / TLS endpoints already read, so it makes no extra Cloudflare call. It is also in the JSON and CSV downloads and at `GET /api/zone-explorer/{zoneId}/certificates`.
- **Rules by hostname:** one card groups every rule (each rule page and Page Rules) by the hostnames it runs on:
  - **Whole zone:** rules with no host condition, which run on the zone and every subdomain.
  - **Apex only:** rules limited to the zone name itself.
  - **One per hostname:** each other hostname with rules of its own, for example `lab.example.com`. These are marked **host-specific**, with whether the hostname has a proxied DNS record, a DNS-only record (its rules do not run) or no record.
  - **Host patterns:** rules limited by a pattern (wildcard, contains, regex, list) rather than an exact name.
  - **DNS hostnames without rules of their own** are listed at the end.

  How the host is worked out:
  - It is read from `http.host` and `http.request.full_uri` conditions (`eq`, `in`, `wildcard`, `contains`, `matches`, `starts_with`, `ends_with`) and from a Page Rule's URL target.
  - A rule counts as host-specific only when every `or` alternative names a host.
  - A negated host condition (`not http.host eq …`, `ne`) leaves the rule zone-wide.

  Every rule table also has an **Applies to** column, and the CSV gets an `applies to` row per rule. API: `GET /api/zone-explorer/{id}/hosts`.
- **Paging:** lists are read across all pages (or cursors), up to 50,000 items each, using the page sizes from the reference.
- **What couldn't be read:** sections the token or the zone's plan can't read are listed separately with Cloudflare's reason. Empty sections show as "nothing configured".
- **Cloudflare calls:** a full read is about 190 `GET`s. Each token can make about six full reads every 5 minutes within Cloudflare's API rate limit, so reports come from the [cache](#cache) for 10 minutes.
- **Downloads:**
  - **JSON**: the whole report.
  - **All as CSV**: every section, every setting and every rule (with a row describing what each rule does), one row per value, with columns `group, section, endpoint, status, item, field, value`. Nested values are flattened into names like `value.strict_transport_security.max_age`. Sections that couldn't be read get one row giving the reason. The file opens in Excel with the right characters, and text that a spreadsheet would run as a formula is prefixed with `'`.
  - **DNS CSV**.
  - **BIND file**: Cloudflare's own `dns_records/export`.
- **Secrets:** secret-looking values (keys, passwords, tokens, and credentials inside URLs such as Logpush destinations) are masked before anything leaves the server. Tokens are decrypted on the server only.
- **Caching and limits:** each section is read and cached on its own endpoint for 10 minutes. Each card says when it was read and whether it came from the cache; its ↻ button reads that section again, and **Read again** reads them all. Each person can open 20 reports a minute. Each view is recorded in the audit log (`cloudflare_zone.viewed`, `cloudflare_zone.dns_exported`).
- **Token permissions:** the more read permissions the token has (Zone, DNS, SSL and Certificates, Firewall Services, Page Rules, Load Balancers, Logs, Access: Apps and Policies …, all **Read**), the more sections it fills in.
- **API:** every section and every download is its own endpoint, cached under its URL path (`?fresh=1` reads it again):

  | Endpoint | What it answers |
  |---|---|
  | `GET /api/zone-explorer` | the zones the tokens can read |
  | `GET /api/zone-explorer/{zoneId}` | the zone's details and the URL of each section and download (no Cloudflare call) |
  | `GET /api/zone-explorer/{zoneId}/sections/{section}` | one card: `zone`, `dns`, `email`, `ssl`, `security_rules`, `security`, `speed`, `cache`, `cache_rules`, `cdn_rules`, `network`, `traffic`, `workers`, `api_shield`, `zero_trust`, `logs`, `other` |
  | `GET /api/zone-explorer/{zoneId}/rulesets` | ruleset names by id (for "execute" rules) |
  | `GET /api/zone-explorer/{zoneId}/certificates` | every certificate: Cloudflare managed or custom, issuer, status, expiry, days left |
  | `GET /api/zone-explorer/{zoneId}/report` | every section in one answer |
  | `GET /api/zone-explorer/{zoneId}/export.json` | **JSON** download |
  | `GET /api/zone-explorer/{zoneId}/export.csv` | **All as CSV** download |
  | `GET /api/zone-explorer/{zoneId}/dns.csv` | **DNS CSV** download |
  | `GET /api/zone-explorer/{zoneId}/dns-export` | **BIND file** download |

  The page opens a zone with its details, then loads the sections four at a time, each card as soon as its endpoint answers. Downloads are built from the cached sections, so they don't call Cloudflare again. One view per person and zone is recorded every 10 minutes (`cloudflare_zone.viewed`); each download is recorded (`cloudflare_zone.exported` with its format, `cloudflare_zone.dns_exported`).

## Monitoring

**Monitoring** checks every Cloudflare account and zone the stored tokens can reach and lists what needs attention. Every role sees it (Tokens & members is for admins and super admins). It needs `supabase/migrations/0010_monitoring.sql` and `0011_monitor_queue.sql`.

| Check | What it finds | Token permissions it reads with |
| --- | --- | --- |
| Security posture | Cloudflare's Security Insights: exposed records, weak TLS, missing protections, users without MFA | Account Settings Read |
| Certificates | Edge, custom-hostname, Origin CA, client and mTLS certificates: expired, expiring (7 days for managed ones, 30 for uploaded ones), stuck in validation | SSL and Certificates Read (zone and account) |
| Tokens & members | API tokens expiring within 14 days, unused for 90, never used, or writing from any IP; members without 2FA; pending invitations | User › API Tokens Read, Account API Tokens Read, Account Settings Read |
| Drift | Watched settings, ruleset versions, DNS records and DNSSEC compared with an accepted baseline (the first run is the baseline) | Zone Settings Read, DNS Read, Zone WAF / Rulesets Read |
| Cloudflare alerts | Notification policies, recommended alert types that are off, failing webhook destinations, and alerts Cloudflare sent to the console | Notifications Read |
| Availability | Failing health checks, tunnels down, unhealthy load-balancer pools, queueing waiting rooms | Health Checks Read, Cloudflare Tunnel Read, Load Balancing Read, Waiting Rooms Read |
| Developer platform | Workers, Pages projects (failed deployments), R2, KV, D1 and queues | Workers Scripts Read, Pages Read, R2 / KV / D1 / Queues Read |
| Scripts & APIs | Page Shield scripts and connections (a score under 50 is suspicious, under 20 likely malicious; 1 = malicious, 99 = not), API Shield endpoints waiting for review | Page Shield Read, API Gateway Read |
| Page Rules | Page Rules still in use and the rule type each setting moves to | Page Rules Read |

- **Findings** have a severity. The same problem keeps one finding across runs; it closes by itself once a run has read its account or zone again and the problem is gone (a failed read never closes one). Admins can dismiss a finding: it stays out of counts and notifications, also after later runs.
- **How it runs (built for thousands of zones):** each check is split into units — one per zone, one per account, or one for the whole console — and each unit has its own next run in `monitor_targets`. The worker takes what is due, hand-started units first, and runs them in **lanes**: one per stored API token, side by side, at most 6 units at a time per token and `MONITOR_PARALLEL` (24) overall. Each lane makes at most `MONITOR_BUDGET` monitoring calls per 5 minutes (**800** of Cloudflare's 1,200 by default; the console's own reads may use up to 1,150). **While a backup or restore uses a token, monitoring makes no calls with it** until it is done; other tokens carry on. A 429 pauses that token until Cloudflare's `Retry-After`. Nothing is lost when the worker stops: what is due stays due in the table, and a unit a stopped worker was running is taken again after 15 minutes. **Overview › API tokens** shows each token's accounts, zones, calls in the last 5 minutes and whether it is paused.
- **How often:** each check has its own interval (Overview › Schedule and notifications), and units with nothing to watch are read less often:

  | Check | Default | Notes |
  | --- | --- | --- |
  | Drift | every hour | one audit-log call per account; only the zones it shows a change in are read again (about 25 calls each). Every zone is also read in full once a week. Needs Account Settings Read for the audit log. |
  | Cloudflare alerts, Availability | every hour | a zone with no health checks or waiting rooms (and an account with no tunnels or pools) once a day |
  | Developer platform | every 6 hours | per account |
  | Certificates | every day | a zone with a certificate expiring within 14 days, or being validated, every 6 hours |
  | Scripts & APIs, Page Rules | every day | a zone where Page Shield / API Shield / Page Rules have nothing, once a week |
  | Security posture, Tokens & members | every day | per account |

  The accounts and zones are listed again every 6 hours, when a credential is added, removed or given a new token, and (in the background) when someone starts checks more than 10 minutes after the last listing. A zone or account no token reaches any more is removed and its open findings close — but only after a listing where every credential could be read.
- **Pages:** results are kept per zone and account (`monitor_results`, `monitor_rows`) and shown 50 rows at a time with search; totals and counts come from SQL. Pages do not reload by themselves: they show the time they are from and a **Refresh** button. **Run all checks** / **Check now** put the units at the front of the queue (`POST /api/monitors/run` also takes `accountId` or `zoneId`); press Refresh to see what is done.
- **Notifications:** a Slack incoming-webhook address and/or any HTTPS webhook (JSON). New findings at or above the chosen severity are sent in one message every 5 minutes at most while units run (`MONITOR_NOTIFY_SECONDS`), and as soon as nothing is due; only findings from the last 24 hours that were never sent are sent; each batch is marked as sent **before** it goes out, so a failure is logged (Overview › Recently sent) and never resent. The addresses are sealed with the vault server key and never shown again. Set `CONSOLE_PUBLIC_URL` (for example `https://console.example.com`) to add a link to the console in each message.
- **Cloudflare's own alerts:** a super admin connects an account on **Monitoring › Cloudflare alerts**. That creates a webhook destination in Cloudflare (the stored token needs **Notifications Edit** for this one step) pointing at `/api/hooks/cloudflare`, with a secret only the console knows. Then choose in Cloudflare › Notifications which alerts go to it. The console must be reachable from the internet at a host in `CONSOLE_ALLOWED_HOSTS`.
- **Drift:** after reviewing changes, accept them as the new baseline (one zone or all). To undo a change instead, restore the zone from a backup. 0011 moves baselines taken before it into one row per zone (`monitor_snapshots`).

**Run the worker on a schedule** (GitHub Actions): scheduled checks run only while the worker is up, so add a schedule to `.github/workflows/worker.yml` that starts it. The worker stays up while units are running (not merely due), and stops by itself when it has been idle for `CONSOLE_WORKER_IDLE_MINUTES` (and before `CONSOLE_WORKER_MAX_MINUTES`). How often to start it is a trade-off between freshness and GitHub Actions minutes (free on public repositories; private ones have a monthly allowance that depends on the plan):

```yaml
on:
  workflow_dispatch:
  schedule:
    - cron: '7 * * * *'      # every hour: hourly checks (drift, alerts, availability) stay on time
    # - cron: '7 */6 * * *'  # every 6 hours: far fewer minutes; hourly checks then run 4 times a day
```

With 66 accounts and about 6,500 zones, the first full read is roughly 150,000–230,000 calls; at 800 calls per 5 minutes per token that is a few hours spread over the tokens, and the worker carries on over several starts if needed. After that, a day is roughly 70,000–100,000 calls (most zones have no health checks, Page Shield or Page Rules, so they are read daily or weekly), so each hourly start mostly has a few minutes of work.

## Zone tags, owners and shortcuts

### Zone tags and owners
Each zone can have console-side tags (`team:payments`, `env:prod`, `customer:acme`, `tier:critical`), an owner, a contact and notes. They live in Supabase (`public.zone_meta`) and are **never sent to Cloudflare**.

- **Tag rules:** lower case; letters, digits and `: . _ / -`; at most 64 characters each and 30 per zone. Spaces become `-`.
- **Where you use them:**
  - **Zone explorer:** a tag and owner filter, tags beside each zone, and an **Edit tags** form on the open zone.
  - **Monitoring findings:** a tag and owner filter, and tags shown on each finding.
  - **Zone tags page** (`/console/zones/tags`):
    - every tag with its zone count;
    - rename, merge (rename into a tag that already exists) or remove a tag;
    - bulk add or remove tags, or set the owner, on the zones you pick or on every zone a search and filter match;
    - CSV export and import.
- **Filters** are resolved in the database (a GIN index on the tags). API routes take `?tags=a,b&owner=…&mq=…`. Several tags mean all of them; the owner match ignores case; `mq` is text in the owner, contact, notes or tags.
- **CSV:**
  - Columns: `zone_id` or `zone_name`, then `tags` (separated by `;`), `owner`, `contact`, `notes`.
  - An import changes only the columns the file has. Zones the tokens cannot read are reported and skipped.
  - The page checks the file first (a dry run), then applies it.
  - Files are limited to about 900 KB. A full export of 6,532 zones is about 500 KB.
- **Permissions:**
  - Reading tags: `runs:read` (every role).
  - Changing them: `zones:tag` (admins and super admins).
- **Audit actions** (all under "Settings & tools" in Changes): `zone_meta.updated`, `zone_meta.bulk_updated`, `zone_meta.tag_renamed`, `zone_meta.tag_removed`, `zone_meta.imported`.

### Favourites, recent zones and saved views
These belong to each user. Rows are keyed by the user id, so nobody sees anyone else's.

- **Favourites:** star a zone in the zone explorer.
- **Recent zones:** the last 20 zones the user opened. A visit is recorded in the background when a zone opens and never delays the page.
- **Saved views:** a page's filters (its query string) saved under a name. The zone explorer has them now (`?q=&tags=&owner=`).
- **Links:** `/console/zone-explorer?zone=<id>` opens a zone directly.
- **Your zones** (favourites and recent zones) is shown on the Overview page.
- **Permission:** `runs:read` for everything here.

### Change reason and ticket on approval requests
Cloudflare change requests (cache purge, Worker and Pages rollbacks, Logpush changes) take an optional **reason** (up to 500 characters) and **ticket** (up to 200). Backup and restore requests are unchanged and don’t take them.

- **Ticket format:** a ticket id such as `CHG-1234`, or an `http(s)` link. Links open with `rel="noopener noreferrer"`. Other link schemes are refused.
- **Where they appear:** on the request on the Approvals page, and in the audit details of `approval.requested`, `approval.approved` and `approval.rejected` (`changeReason`, `ticket`).
- **Direct actions:** a super admin acting directly can also give them; they are recorded in `cloudflare.action`.
- **Requiring a reason:** **Settings → Approval requests → Require a reason** (`settings:write`). The API reads this setting from `GET /api/approvals/policy`.
- **Older requests** saved without these fields still read normally.

### Migration
Run `supabase/migrations/0015_zone_meta.sql`.

- **Tables:** `zone_meta`, `user_zone_favourites`, `user_zone_recents`, `user_saved_views`.
- **Functions:** `zone_meta_*` and `zone_recent_touch`, executable by `service_role` only.
- **Indexes:** GIN on tags, plus `monitor_findings (zone_id)` for open findings.
- **Order:** it can be applied before or after 0010.
- **Without it:** these features answer 503 and name the file; the rest of the console works.
- **Rollback:** `supabase/rollbacks/0015_zone_meta.down.sql`. It deletes the tags and every user's shortcuts, so export the CSV first.

No new environment variables.

## Search and comparisons

### Search every zone ("where is this used?")

**Search** (`/console/search`) finds a value in the stored configuration of every zone in well under a second. You can search for:

- an IP address, or a CIDR range such as `192.0.2.0/24`, which also matches every DNS record or address inside the range;
- a hostname or a CNAME target;
- a header name;
- any text in a rule expression;
- a Page Rule target, a redirect target or a Worker route pattern;
- a setting value.

Each result shows:

- the zone;
- where the value is, for example `DNS A www.example.com` or `Ruleset http_request_firewall_custom rule 3 expression`;
- the matched part of the value;
- where the data came from and how old it is, for example "backup 2d ago" or "drift snapshot 3h ago".

Filters:

- **Match:** *Contains* (3 characters or more) or *Whole value*.
- **Kind:** DNS, settings, rules, headers, redirects, Page Rules, Worker routes, certificates, custom hostnames, scripts, API endpoints, other.
- **Account ID.**
- **Zone tags** (from Zone tags, migration 0015). A zone must have all the tags given.

Results are paged at 50. The first 5,000 matches are counted; when there are more, narrow the search. The header component `ZoneSearchBox` (`src/components/zone-search-box.tsx`) opens this page with the text typed into it. Code (for example a Slack command) calls `searchZones(q, opts)` in `src/lib/zone-search.ts`.

**Search never calls Cloudflare.** It reads an index in Supabase (`zone_search`). The index is filled from data the console already stores:

- **Backups.** When a backup run ends, its zones' `.tf` files are indexed in the background. They are read from this server's backup folder, or from the run's bucket when no local copy was kept. Only each zone's newest backup is kept in the index, and an older backup never replaces a newer one. Secrets and account-level resources are left out: Zero Trust, Spectrum, and attributes such as `*secret*`, `*password*`, `*token*`, `*api_key*` and `private_key`.
- **Drift snapshots.** When the drift check reads a zone, its snapshot is indexed: settings, ruleset phases, DNS records and DNSSEC.
- **Monitoring results.** When a monitoring check reads a zone, these results are indexed: Page Rules, certificates, Page Shield scripts and connections, API Shield endpoints, health checks and waiting rooms.

**Rebuild index** (needs `monitors:manage`) reads everything stored again, in the background on the worker, in this order:

1. the drift snapshots;
2. the monitoring rows;
3. each zone's newest backup, first from this server's backup folders, then from every approved R2 / S3 bucket.

The rebuild skips zones whose newest backup is already indexed. Bucket reads are limited by `ZONE_SEARCH_BUCKET_RPM`. Press Refresh to see how far the rebuild got.

### Comparisons (`/console/compare`)

All comparisons are read-only: nothing is applied.

- **Backup vs backup.** Pick a zone and two of its backups. The page shows what changed, resource by resource, and for each changed resource, attribute by attribute (before and after). Backups are listed from this server's folders and from the approved buckets. Results are paged at 50 and can be filtered by resource type.
- **Zone vs zone.** Pick two zones. Their stored configuration (newest backup and drift snapshot, from the index) is compared item by item. Each zone's own name is written as `{zone}`, and Cloudflare IDs are ignored, so differences that every zone naturally has do not show. Filter by kind, or by what only one zone has.
- **Templates.** A template is a named baseline stored in Supabase.
  - **Create:** start from a zone you trust and choose the kinds to include, for example settings, rules, headers and redirects.
  - **Edit:** for each item, set the expected value and how it is checked (*is*, *contains*, *exists*, *does not exist*), or remove the item.
  - **Gaps report:** for each indexed zone, the items that differ from the template. Zones are sorted by number of gaps, paged at 50, and can be filtered by account, tags or "only zones with gaps". Results are computed from the index in the background and kept. They are computed again when the template changes, when the index has changed (at most every 10 minutes), or when you press Recompute.

### Permissions

| What | Permission |
| --- | --- |
| Search, index status, every comparison, viewing templates and their gaps | `runs:read` (every role) |
| Rebuild index | `monitors:manage` |
| Create, edit and delete templates; Recompute | `zones:tag` |

Template changes go to the audit log as `compare.template_created`, `compare.template_updated` and `compare.template_deleted`. Rebuilds go to the audit log as `search.index_rebuilt`.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZONE_SEARCH_BUCKET_RPM` | `600` | Most R2 / S3 requests per minute that a "Rebuild index" makes while it reads backups from buckets. The lowest accepted value is 30. |

### Migration

Run `supabase/migrations/0016_zone_search.sql` (after 0011). It creates:

- `zone_search`: the index;
- `zone_search_sources`: what is indexed of each zone, and from when;
- `zone_templates` and `zone_template_results`;
- functions, callable by `service_role` only.

It also enables `pg_trgm` in the `extensions` schema. pg_trgm is the trigram index that makes *Contains* searches fast. Where pg_trgm cannot be created, the migration still applies and searches still work, only without that index.

To roll back, use `supabase/rollbacks/0016_zone_search.down.sql`. It deletes the templates. The index is rebuilt with Rebuild index once 0016 is applied again.

If the migration is missing, the pages and API answer 503 and name the migration.

## Investigate

Four read-only tools under **Investigate** (`/console/investigate/...`), for every role (`runs:read`).
None of them changes anything in Cloudflare. They read through `src/lib/cf-read.ts` (the per-token
API budget and the 429 pause). GraphQL queries also wait for room in the same per-token GraphQL budget
the traffic pages use (about 300 queries per 5 minutes; `TRAFFIC_GQL_BUDGET`). Long reads run in the
background: the API answers `202` with progress and a `job` until the result is ready, and a read
nobody polls for 90 seconds is stopped.

### Ray ID lookup — `/console/investigate/ray`

You paste a Ray ID (with or without the `-XXX` data-center suffix). The page shows the request behind
it:
- zone and time
- client IP, country and ASN
- method, host, path and query
- edge status and cache status
- origin status and timing, and bot score, when the zone's plan offers them
- every security event for it: action, source, rule and ruleset

Data comes from GraphQL `firewallEventsAdaptive` and `httpRequestsAdaptive`, filtered by `rayName`.
Both keep about 31 days.

A Ray ID does not say which zone it belongs to, and these datasets are per zone, so you choose where
to look:
- **a zone**
- **a host name or URL** (mapped to its zone from the cached zone list)
- **an account**
- **every zone**

You also choose a window: the last 1 hour, 6 hours, 24 hours, 3 days or 7 days. You can centre it on
an approximate time instead.

How the search works:
- Each query covers up to 10 zones (Cloudflare's per-query limit) that the same token reads, over one
  day.
- Zones are searched busiest first, using this month's traffic when it is already cached (nothing is
  read just to rank them). The newest day is searched first.
- The search stops at the first hit.
- A lookup sends at most `RAY_MAX_QUERIES` queries (default 60; at most 200). Splitting a batch
  Cloudflare refuses, to find the zone it refuses, can add as many again.
- Past the cap, the page says how far the search got and asks you to narrow it.

A zone with a host name costs 1–7 queries. Finding the request then costs 2 more (the zone's limits,
which are kept 6 hours, and the full read).

`src/lib/ray-lookup.ts` exports `lookupRay(ray, opts)` and `rayText(result)` (plain text for a chat
command).

### URL trace — `/console/investigate/trace`

This uses Cloudflare's request tracer, `POST /accounts/{account_id}/request-tracer/trace`.
- **Permission:** read-level, **Account › Request Tracer › Read** ("Allow Request Tracer Read").
- **Origin:** the console always sends `skip_response: true`, so the traced request never reaches
  the origin.
- **Form:** URL, method, protocol, headers, cookies, body, bot score, threat score, country and
  "skip challenge".
- **Result:** a tree of phase → ruleset → rule, with matched steps highlighted. Steps that did not
  match are shown on request.
- **Account and token:** the URL's host picks the zone, and so the account and the stored token.
- **Audit log:** each trace is recorded as `cloudflare.request_traced`, with the method and the URL
  without its query string. Headers and cookies are never logged.

### WAF false positives — `/console/investigate/waf`

This is a **heuristic**. You choose one zone, or one account a page of 5 zones at a time (at most
10), and a window of 24 hours, 3 days or 7 days.

**What it reads:**
- The zone's security events (`firewallEventsAdaptiveGroups`, without log, allow and skip events),
  grouped by rule and by IP, ASN, path and user agent.
- For each suspect rule's main path, how often the other requests to that path answered 2xx or 3xx
  (`httpRequestsAdaptiveGroups`).

**How each rule is scored (0–100):**

| Signal | Points |
| --- | --- |
| Many distinct IPs | up to +20 |
| No single client dominates | +10 |
| One client dominates | −15 |
| Many ASNs | up to +10 |
| Mostly consumer (non-hosting) networks | up to +15, or −10 for hosting networks |
| Ordinary browser user agents | up to +15, or −10 when few are browsers |
| The path normally answers 2xx/3xx | up to +15 |
| Challenge solve rate | up to +20 |
| One rule dominating one path | +10 |

Every signal is shown with its reason.

**Draft exception:** each suspect comes with a draft you copy into the dashboard; the console never
creates it.
- **Managed rule:** a skip rule in `http_request_firewall_managed` with
  `{"rules": {"<ruleset>": ["<rule>"]}}`, placed before the execute rule.
- **Super Bot Fight Mode:** a custom skip rule with `{"phases": ["http_request_sbfm"]}`.
- **Legacy products:** a custom skip rule with `{"products": [...]}`.
- **Custom and rate limiting rules:** the expression to add to the rule's own expression
  (`and not (...)`).

**Cost:** about 2–8 queries per zone. Each zone's result is kept 30 minutes.

### Zone timeline — `/console/investigate/timeline?zone=ID`

One time axis for a zone, over 6 hours (5-minute buckets) or 24 hours, 3 days or 7 days (hourly). It
combines:
- **Configuration changes:** from the activity page's audit-log cache (`cachedActivity`), for this
  zone only.
- **Traffic:** requests, 4xx, 5xx and blocked or challenged events (GraphQL, 1–4 queries). A spike is
  a bucket that is at least 20 events (50 for blocked), at least 3× the window's median, and more
  than 6 robust deviations above it. For 4xx and 5xx it must also be at least 2% of requests.
- **Deployments:** versions of the Workers routed on the zone, and deployments of the Pages projects
  that serve its hosts (`workerVersions` and `pagesDeployments`, GET only; at most 5 of each).
- **Stored monitoring data:** certificate expiry (`monitor_rows`), the zone's open findings (drift,
  health checks …) and alerts Cloudflare sent to the console.

The result is kept 5 minutes. If one source fails, it is listed with its reason. The zone explorer has
a **Timeline** button, and each monitoring finding about a zone has a **Zone timeline** link.

### Cloudflare permissions

All of these are read permissions:
- **Zone › Analytics › Read:** GraphQL, for all four tools.
- **Account › Request Tracer › Read:** URL trace.
- **Zone › Zone WAF / Rulesets Read:** ruleset names. Optional; IDs are shown without it.
- **Account › Account Settings › Read:** audit log, for the timeline.
- **Zone › Workers Routes › Read** and **Account › Workers Scripts › Read:** Worker versions, for the
  timeline.
- **Account › Cloudflare Pages › Read:** Pages deployments, for the timeline.

### Environment variables

- `RAY_MAX_QUERIES` (default 60, at most 200): the most GraphQL queries one Ray ID search sends.

### Migration

None. Results are kept in the shared cache (`src/lib/cache.ts`: Redis when configured, otherwise
memory), under `investigate:*` keys.

## DNS hygiene, load balancing, IP & ASN lists, zone health and onboarding

All read-only against Cloudflare. Three new monitoring checks run in the existing queue under each token's budget; three new pages read what the checks stored.

### Monitoring checks (Monitoring tabs)

| Check | Unit and interval | Cloudflare calls | Token permissions (read) |
| --- | --- | --- | --- |
| **DNS hygiene** (`dns`) | each zone, daily | 3 per zone: zone details, DNS records (with proxy status), DNSSEC (skipped when drift's snapshot from the last 2 days says DNSSEC is off) | Zone: Zone Read, Zone: DNS Read |
| **Load balancing** (`loadbalancing`) | each account hourly (pools, monitors, pool health); each zone every 6 h (load balancers + 24 h failovers); accounts/zones without any: weekly | 2 + 1 per pool (account); 1 + 1 GraphQL query (zone with load balancers) | Account: Load Balancing: Monitors and Pools Read, Zone: Load Balancers Read, Zone: Analytics Read |
| **IP & ASN lists** (`lists`) | each account daily (lists + account rulesets); each zone daily, only if its account has lists | 1 + 1 per account ruleset; zone: 1 + 1 per zone ruleset | Account: Account Filter Lists Read, Account: Account Rulesets Read, Zone: Zone WAF / Rulesets Read |

**DNS hygiene** finds: dangling CNAMEs (target NXDOMAIN; critical on services where an unclaimed name stops resolving — Azure, Elastic Beanstalk, Heroku DNS — high on others in the takeover-prone list in `src/lib/dns-hygiene.ts`, medium for any other external target); delegation (public NS elsewhere, extra or missing nameservers, domain not resolving, pending for more than 3 days, moved); DNSSEC against the DS at the parent (DS present but DNSSEC off — critical, key tag mismatch — high, signing without DS — low); unproxied A/AAAA/CNAME records that expose a proxied record's origin (same name, same IP or same CNAME target).
Public DNS is asked over DNS-over-HTTPS to Cloudflare's public resolver 1.1.1.1 (`https://cloudflare-dns.com/dns-query`) — not the API, no token. At most 6 lookups at once per process, at most 60 per zone and run; answers are cached by TTL; CNAME answers are kept a week in the unit's state, so large zones are covered over several runs.

**Load balancing**: the public API no longer has a health-event log, so "events" are failovers — 15-minute windows in which a load balancer sent most traffic to a different pool than before (GraphQL `loadBalancingRequestsAdaptiveGroups`, a POST that only reads). Nothing drains, enables or disables anything.

### Pages

- **/console/health** — Zone health: one 0–100 score per zone, worst 20 first, sortable, paged, filter by account, tag (zone tags from 0015) and name. Each row explains its score. Also a card on the Overview.
  Score = 100 minus: 25 per open critical finding, 10 per high, 4 per medium, 1 per low (× check weight: certificates 0.5, drift 0; at most 50 per check); 3 per failing check and 1 per check never run on the zone (at most 15 and 10); 30 for an expired certificate, 15 within 7 days, 5 within 30; 1 per drift change (at most 10). Dismissed findings do not count.
  Scores live in `zone_health` and are recomputed by database triggers when a zone's monitoring unit finishes or one of its findings is dismissed, brought back or resolved — the page never recomputes.
- **/console/lists** — every IP, ASN, hostname and redirect list with its item count and the rules (account and zone) that use it. Opening a list reads its items from Cloudflare (50 at a time, Cloudflare's own search).
- **/console/onboarding** — compare a BIND zone file (pasted or uploaded, at most 512 KB, parsed on the server, not stored) with the zone's current records on Cloudflare (Cloudflare's BIND export, one call, kept 5 minutes): missing, only on Cloudflare, different, TTL and proxy differences, and records that will break (MX/SRV/NS at a CNAME, CNAME next to other records, names outside the zone). Watch a zone: status, the nameservers Cloudflare assigned against what public DNS returns now, on demand; the zones not yet active are listed from the DNS hygiene check.

Permissions in the console: everything is `runs:read` (every role); running the checks by hand stays `monitors:manage`.

### Environment variables (optional)

| Variable | Default | |
| --- | --- | --- |
| `DNS_HEALTH_DOH` | on | `off` turns public DNS lookups off (delegation, DS and CNAME targets are then "not checked"). |
| `DOH_URL` | `https://cloudflare-dns.com/dns-query` | Another DoH JSON resolver (tests use a fake). |

### Database

Run `supabase/migrations/0018_zone_health.sql` (after 0010–0012). It adds `zone_health`, its triggers on `monitor_targets` and `monitor_findings`, readers for stored rows (`monitor_rows_filtered`, `monitor_rows_accounts`, `monitor_snapshot_dnssec`) and indexes. It scores what monitoring already stored. Without it the three pages answer 503 naming the file; DNS hygiene and load balancing still run, the lists check's account units wait for it. Rollback: `supabase/rollbacks/0018_zone_health.down.sql` (loses only the scores).

## Security audit (one zone)

**Console › Security audit** (`/console/security-audit`) checks one zone against a fixed set of rules derived from the `security-audit` skill (`.claude/skills/security-audit/`). It also reports how the zone's security rules acted on its traffic. Choose a zone with the search box (the search runs on the server, so the browser never loads the whole zone list). Pick a traffic window (24 hours, 7 days by default, or 30 days, shortened to what the plan keeps) and press **Run audit**. The report opens at `/console/security-audit/{id}`. The Zone explorer's zone view has a **Security audit** button that opens the page with that zone chosen.

**No AI and no writes.** Every rule is plain code with a documented condition (`src/lib/zone-audit/rules.ts` for configuration, `effectiveness.ts` for traffic). Each rule names the skill attack class it implements and the skill file it comes from. The audit only reads Cloudflare. Fixes are written out as dashboard steps and are never applied.

**Verdicts.** A finding is **Confirmed** only when the zone's configuration, or the traffic numbers, prove the outcome. Example: SSL Flexible means the leg from Cloudflare to the origin is plain HTTP. A finding is **Needs validation** when the outcome depends on something the configuration cannot show, such as how the origin behaves, what an unproxied host serves, or headers the origin sets. Each such finding gives the exact check to run.

**Coverage ledger.** Every rule ends in one of four states:
- **passed**
- **finding**
- **not applicable**: the plan or zone lacks the product.
- **not read**: a permission was refused or the API failed. The ledger names the token permission that would read the data.

This keeps a clean result from being mistaken for "everything was checked".

**Report contents:**
- A summary by severity and verdict.
- Configuration findings, worst first, each with evidence (secret-looking values masked), root cause, fix and validation.
- **Rule effectiveness**: per custom, managed, rate limiting, bot and DDoS rule, the hits by action, the challenge solve rate, the top paths, countries and networks, and the trend against the previous window.
- Recommendations drawn from the traffic.
- The coverage ledger.
- What was read.

**Downloads:** `REPORT.md`, `findings.json` (the finding records), and CSV for the findings, the rule-effectiveness table or the coverage ledger.

**Rule areas.**

| Area | What the rules check |
| --- | --- |
| Transport | SSL mode, minimum TLS, TLS 1.3, Always Use HTTPS, HTTPS rewrites, HSTS, authenticated origin pulls, edge certificates |
| Origin exposure | Unproxied records that reveal a proxied origin, unproxied management or non-production names, dangling CNAMEs to takeover-prone services, wildcards |
| Email and DNS | SPF, DMARC, CAA, DNSSEC |
| WAF | Cloudflare Managed and OWASP rulesets, broad skip rules, skips keyed on client-supplied headers, disabled rules, security level, browser integrity check, Bot Fight Mode |
| Availability | Rate limiting, HTTP DDoS overrides, development mode |
| Cache | Cache-everything rules on per-user paths, Cache Deception Armor, unkeyed query strings |
| Host trust | Origin-rule Host/SNI overrides, True-Client-IP |
| Client-side | Security headers set at the edge, Page Shield |
| Edge | Worker routes, including Worker-less routes on sensitive paths |
| Traffic | Rules with no hits, log-only rules matching automated traffic, likely false positives (the WAF false-positive score and draft exception), skip rules letting through clients other rules stop, managed rules mostly logging, rate limits that never trigger on busy paths, busy failing paths and hosting networks with no rule acting |

**Permissions.** Viewing and starting an audit both need `runs:read` (every role), because an audit only reads. Starts are limited to 10 per user per 10 minutes, one running audit per zone, and at most 3 running at once per worker. Each start is written to the audit log as `zone_audit.started`, and each download as `zone_audit.downloaded`.

**Cost of one audit.** About 28 Cloudflare API GETs (the zone, 11 settings, 7 ruleset phases, DNS records, DNSSEC, certificate packs, authenticated origin pulls, bot management, Page Shield, page rules, Worker routes, managed transforms). The traffic window adds about 16 GraphQL analytics queries for 7 days with the usual 3-day query span; 30 days, or plans with a 1-day span, take up to about 60 (at most 12 window parts per dataset). These use the shared analytics budget. On top of that come up to 40 public DNS lookups (DoH) for CNAME targets. All calls go through `cf-read.ts` and `investigate-gql.ts`, with the token from the zone's stored credential. There is no run that audits every zone, on purpose: 6,532 zones would be about 290,000 calls. Every page that lists stored audits reads only the database.

**Cloudflare token permissions** (all read; the audit never needs or uses an edit permission):
- Zone Read
- Zone Settings Read
- DNS Read
- SSL and Certificates Read
- Zone WAF Read
- HTTP DDoS Managed Ruleset Read
- Cache Settings Read
- Origin Read
- Transform Rules Read
- Managed headers Read
- Bot Management Read
- Page Shield Read
- Page Rules Read
- Workers Routes Read
- Analytics Read

A missing permission marks only the rules that need it as "not read".

**Environment.**
- No new variables.
- `DNS_HEALTH_DOH=off` turns off the CNAME lookups. The dangling-CNAME rule then shows "not read".
- `TRAFFIC_GQL_BUDGET` and `TRAFFIC_GQL_WINDOW_MS` (existing) bound the analytics queries.

**Migration:** `supabase/migrations/0021_zone_audits.sql`, rollback `supabase/rollbacks/0021_zone_audits.down.sql`.
- It creates the table `zone_audits`, which keeps the newest 20 audits per zone and has a `latest` flag for the all-zones list.
- `zone_audit_start` refuses a second audit of a zone while one is running, and marks audits that have been running for more than 15 minutes as failed.
- `zone_audit_latest` pages the newest audit of each zone, sorted by worst severity, newest, or name.
- RLS is on and only the service role has access.
- Without the migration, the page and the API answer 503 and name the file.

## Operator tools: Worker logs, API console, Logpush

### Live Worker logs (`/console/tools/worker-logs`)
Follow one Worker's requests, `console.log` lines and exceptions while they happen. Pick an account and a Worker (the list comes from the Developer platform check's stored rows; **Read from Cloudflare** lists it live), set filters (outcome ok / error / exception / canceled, HTTP method, log text, sampling 1–100 %), then **Start**.

- The console creates a Cloudflare tail (`POST /accounts/{id}/workers/scripts/{name}/tails`) and opens its WebSocket (`trace-v1`) on the server that runs the API: the worker on Vercel deployments. The page asks for new events every 3 s, only while the tab is visible. Streaming through the web-to-worker relay is not possible.
- A session ends when you press **Stop**, after 10 minutes, when the page has made no request for 90 s (tab closed or hidden), when Cloudflare closes the stream, or when the server holding it goes away (another worker ends it). When it ends, the tail is deleted at Cloudflare and every stored event is deleted with it.
- While a session runs, events are stored in `worker_tail_events` in a short form: time, outcome, method, URL (credentials and secret-looking query values blanked), status, colo, log lines, exceptions. Request headers, cookies and client IPs are never stored. At most 1,000 events per session and 50 per second are kept. Additional events are counted as "left out".
- Limits: one session per user and five in the whole console. Every start and stop is audited (`worker_tail.started` / `worker_tail.stopped`).
- Needs **Node.js 22+** where the API runs, because it uses Node's built-in WebSocket. The worker workflow already uses Node 22. On older Node the start request answers 501.

### API console (`/console/tools/api`)
Run a read-only GET against `https://api.cloudflare.com/client/v4` with a stored Cloudflare credential. Pick the credential, an account and a zone (these fill `{account_id}` / `{zone_id}`), and type a path. Common paths are offered as you type.

- Only GET is sent. A path must be relative and start with `/accounts`, `/zones`, `/user`, `/memberships`, `/ips`, `/radar`, `/certificates` or `/organizations`. Absolute URLs, `//`, `..` (also percent-encoded), `\` and `#` are refused. Paths that return a plain-text secret (`…/token`) are refused too.
- Calls spend from the token's shared rate-limit budget (`cf-read.ts`). Secret-looking values in the answer are masked. Answers over 2 MB are cut and shown as text with a notice. The viewer offers collapse/expand, copy, and **Next page** (page numbers or cursor).
- Saved queries are kept per user (up to 100) in `api_saved_queries`, with their placeholders.
- Every call is audited as `cloudflare.query` with the path, credential name, status, size and time. The answer is never logged or stored. The token never leaves the server.

### Logpush (`/console/logpush`, and the **Logpush** monitoring tab)
A new monitoring check, `logpush`, reads every account's Logpush jobs every hour and every zone's every 6 hours. Zones without jobs are read once a day. The page lists the stored jobs worst first, 50 at a time, with filters for status, account or zone, and text. It loads once; **Refresh** reloads it and **Check now** re-reads Cloudflare.

- Status: **Failing** means the last error is newer than the last push. **Stale** means nothing was pushed for 24 h. **Turned off** and **Not pushed yet** are also shown. Failing jobs raise a high finding, stale jobs a medium one, and turned-off jobs an info one. Findings go through the usual notifications.
- Destinations are shown as scheme and host only (for example `s3://bucket`). Paths, query strings, keys, SAS tokens, headers and `user:pass@` are never stored or shown. Error messages have URLs cut to the host and secret-looking parameters blanked.
- **Managing jobs** (the one exception to read-only): create, edit (name, enabled, filter, output options, batch limits, destination, ownership challenge), turn on or off, and delete. Each is a Cloudflare action of kind `logpush` (`POST /api/cloudflare/actions`, permission `cloudflare:act`). A super admin's action runs at once. An admin's waits on the Approvals page and runs once when approved.
  - **Stored tokens never change Logpush.** Every write runs with a credential typed in when the change runs: an **API token with Logs Edit** on the account or zone, or a **Global API Key with its account email**.
    - A super admin acting directly enters it in the dialog.
    - An admin's request carries no credential. The super admin who approves it is asked for one when they press **Approve and start**.
    - Fields are password-type with autocomplete off, and are cleared when the dialog closes.
  - The credential lives only in memory for that one request. It is not saved in Supabase, approval records, files, the cache, the audit log or server logs, and it is never returned. The reference is dropped after use.
    - On Vercel the credential travels to the worker inside the sealed relayed request, like any request body.
    - The audit log records only which kind was used (`auth: api_token` or `global_api_key`).
  - If Cloudflare refuses the credential (wrong, or no Logs Edit), the message names **Logs Edit**. An approval then **stays waiting**, so it can be approved again with another credential. A missing credential is treated the same way.
  - The approval shows before → after for each field.
  - The new destination and the ownership challenge are sealed with the server key inside the request and are opened only to send them to Cloudflare.
  - If the job changed in Cloudflare after the request was made, it is refused (409).
  - Cloudflare validates new destinations (`validate/destination`) right before the change, with the same typed-in credential, because validation needs Logs Edit too. An admin's request is therefore not validated until it is approved.
- **Ownership challenge** asks Cloudflare to write a challenge file into the destination (`POST …/logpush/ownership`). It needs Logs Edit, so it also asks for a typed-in credential. It is audited as `logpush.ownership_requested`.
- Reading stays on the stored tokens: the list, the monitoring check, and the current settings shown in the edit dialog.
- These few typed-in calls go straight to the Cloudflare API, like the activity revert does, not through the stored tokens' rate budget.

### Permissions
| Feature | Console permission | Cloudflare token permission |
| --- | --- | --- |
| Worker logs | `cloudflare:query` | Account › **Workers Tail Read** (create/delete tail; read-only, changes nothing in the Worker). Workers list: Account › Workers Scripts Read |
| API console | `cloudflare:query` | Whatever the path needs (read permissions) |
| Logpush list / check | `runs:read` | Account › **Logs Read**, Zone › **Logs Read** |
| Logpush edit form (live read) | `cloudflare:act` | Logs Read |
| Logpush changes, validation, ownership challenge | `cloudflare:act` (+ super admin approval) | **Typed in at run time, never stored:** an API token with Account › **Logs Edit** / Zone › **Logs Edit** (Cloudflare's API reference calls it "Logs Write"), or a Global API Key and its email. The stored tokens need only Logs Read. |

### Database
Migration `supabase/migrations/0019_ops_tools.sql` (rollback `supabase/rollbacks/0019_ops_tools.down.sql`) adds:
- `api_saved_queries`
- `worker_tail_sessions` (the Cloudflare tail id is stored sealed; the WebSocket URL is never stored)
- `worker_tail_events`

Without the migration, Worker logs and saved queries answer 503 naming the file. Running queries still works. The Logpush list uses monitoring's tables (0010–0012).

### Environment
No new variables.

## Scheduled reports

**Reports** (`/console/reports`) makes daily or weekly summaries and sends them to Slack, to the
webhook, or both. You can also keep them in the console only and download them.

Each report has:

- **Scope.** Everything, some accounts, or the zones that carry every one of a set of zone tags.
- **Schedule.** Daily, or weekly on a chosen day, at a chosen hour in US Eastern time (America/New_York): 07:00 means 07:00 EST in winter and 07:00 EDT in summer. Every time in a report, its downloads and its Slack message is shown in Eastern time with EST or EDT.
- **Sections.** Any of the five listed below.
- **Channels.** The Slack and webhook addresses set in **Monitoring › Settings**.

The sections:

| Section | Where the numbers come from |
| --- | --- |
| Configuration changes | The Cloudflare audit logs: the same cached read as the Cloudflare activity page, one read per account |
| Monitoring findings | Open findings by severity, plus the findings found and resolved since the report before |
| Traffic & security | Requests, cache, bandwidth, page views and security events by action, against the period before. Read when the report is made, as account-level totals: two GraphQL queries per account, never one per zone. A tag report reads per zone, capped at 100 zones |
| Expiring certificates | Certificates expired or expiring within 30 days, from the certificates check |
| Coverage problems | Monitoring units that failed or were never read |

**Only measured numbers.** A section that could not be read says why, for example "the token
cannot read analytics". An empty section says "nothing". An account whose traffic could not be read
is listed by name and is left out of the totals.

**Checks that need `audit:read` are left out.** Reports are visible to every role and go to shared
channels, so Tokens & members findings never appear in them.

### How reports are made and sent

- **The worker makes them** (`CONSOLE_ROLE=worker`), the same way monitoring runs on its schedule.
- **Every minute, the worker looks for due reports.** It takes each one with a single conditional
  update (`report_claim`), so when there are several workers, only one makes a given report.
- **Late reports are made once.** A report whose worker was away is made one time, covering the
  period up to now. It is not made again for each slot that was missed.
- **Each run goes to each channel once.** The channel is claimed before the send
  (`report_claim_delivery`). A failed send is recorded on the run and in the notification log, and is
  never retried.
- **Unfinished runs are not made again.** If a worker stops partway through, the run is marked
  failed after 30 minutes and nothing is sent.
- **The worker does not retire while making a report.** On GitHub Actions it waits for the report
  to finish first.
- **"Make now" and "Make and send"** start a run straight away, on the worker. A second run of the
  same report is refused while one is in progress.
- **History keeps the newest 50 runs per report.** Each run can be downloaded as a standalone HTML
  file (no scripts and no external resources, served with a `sandbox` CSP), and each section as CSV.

**Email is not built in.** The console has no email sender, and adding one is a hosting and secret
decision. Until then, there are three options:

- Download the HTML file and attach it.
- Point the webhook at an email relay you already run, such as Zapier, Make, n8n or a small Worker
  that calls your mail API. The webhook body carries the whole report as JSON (`event: "report"`).
- Add an SMTP or API mail provider later. This needs a secret (`SMTP_URL` or a provider API key) and
  a sender domain with SPF and DKIM set up.

### Permissions

| Action | Permission | Roles |
| --- | --- | --- |
| View reports, history and downloads | `runs:read` | Every role |
| Create, change and delete reports; make one now | `monitors:manage` | Admins and super admins |

### Migration

Run `supabase/migrations/0020_reports.sql`. To undo it, run `supabase/rollbacks/0020_reports.down.sql`.

It adds:

- **Tables:** `report_definitions`, `report_runs` and `slack_users`.
- **Indexes on the existing monitoring tables:** `first_seen` and `resolved_at` on `monitor_findings`,
  and failing targets on `monitor_targets`.
- **Functions** (all `service_role` only): `report_claim`, `report_start`, `report_claim_delivery`,
  `report_delivered`, `report_finding_counts`, `report_findings_list`, `report_expiring_certs`,
  `report_coverage`, `report_coverage_problems`, `report_latest` and `report_accounts`.

Without the migration, the Reports pages and the Slack command answer 503 and name the file.

### Cloudflare permissions (read only)

| Permission | Used for |
| --- | --- |
| Account › Account Analytics › Read | The traffic and security totals in all-zones and account reports |
| Zone › Analytics › Read | The same totals in tag reports |
| Account › Account Settings › Read and Zone › Zone › Read | The configuration-changes section, through the existing audit-log read |

The GraphQL queries are sent as POST, because that is how GraphQL takes them. They change nothing.

### Environment

| Variable | Default | What it does |
| --- | --- | --- |
| `REPORTS_TICK_MS` | 60000 | How often the worker looks for due reports |
| `CONSOLE_PUBLIC_URL` | (unset) | Already used by monitoring. When set, Slack messages link to the report |

## Slack command (read only)

`/castellan` answers in Slack, and only the person who asked can see the answer:

| Command | Answer |
| --- | --- |
| `zone <name>` | Status, plan, account, tags, owner, open findings by severity, and monitoring health |
| `findings <zone>` | The zone's 15 worst open findings |
| `search <text>` | Searches every zone's stored configuration, using the zone search index when there is one, otherwise zone names |
| `ray <ray id> [zone]` | What happened to one request, using the Ray ID lookup |
| `help` | The list of commands |

Nothing changes anything, in the console or in Cloudflare.

### Security

- **Signed requests.** Every request must carry Slack's v0 signature: an HMAC-SHA256 of
  `v0:timestamp:body` made with `SLACK_SIGNING_SECRET`. The signature is compared in constant time.
- **Five-minute window.** A request more than 5 minutes old or ahead is refused.
- **No replays.** Each signature is accepted once.
- **The hook checks the signature instead of the Origin.** Slack sends no Origin header, so
  `/api/hooks/slack` works like `/api/hooks/cloudflare`. `publicRoute()` would refuse these
  requests.
- **Default deny.** Only the Slack users that admins list in **Settings › Slack** get an answer.
- **Linked users.** Each listed Slack member ID acts as one console user, with that user's current
  role. Disabling or deleting the console user stops the Slack user too.
- **Workspace pinning.** A link can be tied to one workspace. `SLACK_TEAM_ID` restricts the command
  to a single workspace.
- **Who can link whom.** An admin can link themselves, or any user whose role they manage, which
  excludes super admins.
- **Answers go only to Slack.** Slack expects a reply within 3 seconds, so the console acknowledges
  at once. It then posts the answer to the command's `response_url`, which must be on
  `https://hooks.slack.com/commands/…` or `/actions/…`, through `safePost`.
- **Web and worker roles.** On the web role (Vercel), the answer is worked out on the worker, through
  the existing relay.
- **Audit.** Every command is written to the audit log as `slack.command`.

**How Slack users are mapped to console users.** These were the options:

1. An allow-list of Slack member IDs, each linked to a console user, kept by admins. **This is what
   is built.** It needs no Slack bot token and no extra scopes.
2. Look up the Slack user's email with `users.info` and match it to a console user. This needs a bot
   token with `users:read.email` stored as a secret, and it trusts Slack's email field.
3. Let people link their own Slack account from the console, through a one-time code sent with the
   command. This means more work for each user.

### Creating the Slack app

Do this in Slack. Nothing in it is configured by the console.

1. Go to <https://api.slack.com/apps>, choose **Create New App › From scratch**, give it a name such
   as "Castellan", and pick your workspace.
2. Go to **Slash Commands › Create New Command**:
   - **Command:** `/castellan`. If you choose another name, set `SLACK_COMMAND` to match.
   - **Request URL:** `https://<your console host>/api/hooks/slack`. Settings › Slack shows this URL
     when `CONSOLE_PUBLIC_URL` is set.
   - **Short description:** "Read-only answers from Castellan". **Usage hint:**
     `zone <name> | findings <zone> | search <text> | ray <id> [zone] | help`.
3. Go to **Basic Information › App Credentials** and copy the **Signing Secret**. Set it as
   `SLACK_SIGNING_SECRET` on the web side and on the worker, the same places you set the other
   secrets (Vercel, the worker host), then redeploy. Never paste it into chat or commit it.
4. Choose **Install App › Install to Workspace**. The app needs only the `commands` scope.
5. Optionally, find the workspace ID (it starts with `T`, for example in the URL of
   `https://app.slack.com/client/T…/`) and set it as `SLACK_TEAM_ID`.
6. In the console, open **Settings › Slack** and add each person's Slack member ID. In Slack, that is
   their profile › ⋮ › Copy member ID. Choose the console user they act as.
7. Test it in Slack with `/castellan help`, or from **Settings › Slack › Try a command**.

**The hook must be reachable from Slack over HTTPS.** If `CONSOLE_ALLOWED_HOSTS` or
`CONSOLE_ORIGIN_SECRET` is in use, Slack's requests must arrive through that host or CDN. Allowing
that is a hosting decision.

### Permissions

| Action | Permission |
| --- | --- |
| View Settings › Slack | `settings:read` |
| Add or remove Slack users | `settings:write` (admins) |
| `/api/slack/answer` (the answer itself, and "Try a command") | `runs:read` |

### Environment

| Variable | Required | What it does |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | Yes | Without it, `/api/hooks/slack` answers 404 |
| `SLACK_COMMAND` | No (default `/castellan`) | The command name |
| `SLACK_TEAM_ID` | No | Allows one workspace only |

## Cache purge and rollbacks

- **Cloudflare › Cache purge:** purge by URL, prefix, host name or cache tag (up to 100 at a time), or everything (type the zone name to confirm). The stored token needs **Cache Purge**.
- **Monitoring › Developer platform › Roll back:** deploy an earlier version of a Worker to all traffic, or make an earlier production deployment of a Pages project live again. The token needs **Workers Scripts Edit** or **Cloudflare Pages Edit**. Bindings and secrets of a Worker are not rolled back.
- Admins ask; a super admin approves on **Approvals** (a "Cloudflare change") and it runs at once. A super admin's own purge or rollback runs immediately. Every one is in the audit log.

## DNS & Workers analytics

**Cloudflare › DNS & Workers** shows, for the last 24 hours, 7 or 30 days, the DNS queries Cloudflare answered for a zone (per hour or day, top names, record types, response codes) and, per account, Worker requests, errors and CPU time (p99). It reads Cloudflare's GraphQL Analytics API (Account Analytics Read) and keeps each answer for 10 minutes.

**Cloudflare activity › Who read the configuration** lists the people and tokens that viewed settings (Audit Logs v2 "view" entries, which the change timeline leaves out), with how often and from where.

## Cache

Cloudflare reads are kept in a shared cache, so pages open without calling the API again:

Every read-only Cloudflare view is its own endpoint, and its cached copy is kept under its URL path (`path:/api/zone-explorer/{zone}/sections/dns`, `path:/api/cloudflare-audit?credentialId=all&range=week` …):

| What | Kept for |
|---|---|
| Zone explorer: zone list, each section, ruleset names, BIND export | 10 minutes |
| Cloudflare activity: each account and period (`/api/cloudflare-audit?…`; the CSV download `/api/cloudflare-audit/export.csv` is built from it) | 2 minutes |
| Backup and restore zone pickers | 2 minutes |
| Cloudflare activity: each account's zones | 5 minutes |
| Cloudflare activity: Resource History lookups (old values of a change) | 10 minutes |
| Cloudflare activity: product categories | 6 hours |

- **Where:** in Redis when `REDIS_URL` is set (shared by every console process and kept across restarts), otherwise in the server's memory. If Redis can't be reached the console uses memory and tries Redis again every 30 seconds — the cache never stops a page from loading.
- **Encrypted:** values are sealed with AES-256-GCM under a key derived from the vault server key before they go to Redis, so Redis only holds ciphertext. API tokens are never cached; cached data is already masked.
- **Fresh data:** **Read again** (or a card's ↻) in the zone explorer and **Refresh** in Cloudflare activity skip the cache (`?fresh=1`). Reverting a Cloudflare change drops that zone's cached endpoints and the cached activity; applying a restore drops the zone's. Concurrent requests for the same data share one read.
- **Not cached:** pages with per-person, live or secret data — vault, credentials, users, sessions, runs and their logs, the console audit log, settings — and anything that changes something (revert, backup, restore). A shared cache would hand one person's view to another. Tabs and filters that work on data already on the page (Cloudflare activity's categories and views, the zone explorer's find box) make no request.
- **Names:** keys start with `REDIS_PREFIX` (default `backup-console:`). `REDIS_*` variables are removed from the environment before `backup.js` and Terraform start.

## Security

| Control | How the console does it |
|---|---|
| Row-level security | RLS is on for every table, and `anon` / `authenticated` have no rights at all (also for future tables). Only the server, with the service-role key, reads or writes data. |
| Auth on every API route | Every route goes through `route()` (session + permission) or `publicRoute()` — only sign-in, sign-out and first-run setup are public. |
| Never trust the frontend | Every permission, role change, bucket and input is checked on the server; the UI only hides what the server already refuses. |
| Rate limiting | Per user: 600 requests and 60 changes a minute; tighter per route (revealing secrets 20, testing keys / finding buckets 20, vault unlock 10, vault password 5, restore apply 10 a minute). Public routes: 30 a minute per client address, plus sign-in back-off and a global sign-in limiter. Answers 429 with `Retry-After`. |
| Sanitize user input | JSON bodies only (`415` otherwise), at most 1 MB (`413`); fields are validated against their formats (bucket names, endpoints, IDs, regions …) before use. |
| Parameterized queries | All database access goes through the Supabase client (parameterized); no SQL is built from input. |
| Lock down CORS | No CORS: the API is same-origin only. Writes need an `Origin` of an allowed host, cross-origin preflights get 403 and no `Access-Control-Allow-*` header. |
| HTTPS everywhere | Plain HTTP only on loopback; anything else is redirected (GET) or refused, and HTTPS answers carry HSTS (2 years). Cookies are `Secure`, `HttpOnly`, `SameSite=Strict`. |
| Stop IDOR bugs | Every object route checks the caller's permission; run files are read only inside that run's folder (symlinks resolved); restores and credentials are only reachable with their permissions. |
| Debug mode off in prod | Errors are answered generically with a reference (details only in the server log). In development mode (`npm run dev`) admins see a warning — use `npm run build` + `npm start` for real use. |
| CAPTCHA on public forms | Cloudflare Turnstile on sign-in and first-run setup: set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`. The server verifies every token with Cloudflare; the CSP then allows `challenges.cloudflare.com` only. Off until both keys are set. |
| Log admin actions | The audit log records every user, role, setting, vault, credential (including each secret reveal), backup and restore action, plus refused (`security.denied`) and rate-limited (`security.rate_limited`) attempts. |
| Private storage buckets | **Test** on an account set fails if a bucket can be listed without keys, or (AWS) if S3 reports it public. An R2 public `r2.dev` URL or custom domain is not visible to the S3 API — keep it off in the dashboard. |
| Hide admin pages properly | Admin pages are guarded on the server (`src/lib/page-guard.ts`): without the permission they answer 404 and are never sent, not merely hidden. |
| Update vulnerable packages | `npm audit` — currently 0 known vulnerabilities. Run it after every `npm install`. |
| Check file upload types | The only upload is a `.env` file: plain text only (no binary/control characters), 64 KB at most — checked in the browser and again on the server. |
| Security review | An independent code review (authorization, secrets, process spawning, SSRF, injection) found three issues, all fixed: **restore no longer trusts bucket content** — the backup's `provider.tf` is never used, only literal `cloudflare_*` resource blocks reach Terraform (no provisioners, provider overrides, interpolation or function calls such as `file()`; refused blocks are audited as `security.restore_blocks_refused`), and Terraform may install only the Cloudflare provider; **a run's output folder must be inside the admin-set output folder** (no other paths or network shares); **sign-in guesses cannot be raced** (one password check per account at a time) and the client address is the proxy-added (last) `X-Forwarded-For` hop, or the header named in `CONSOLE_CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`). |
| Security headers | CSP (no external sources; `frame-ancestors 'none'`), HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP / CORP `same-origin`, `Cache-Control: no-store`, no `X-Powered-By`. |
| Verify webhook signatures | The console has no webhooks, so there is nothing to verify. |

## What's stored where

| Supabase | Local (`data/`, gitignored) |
|---|---|
| `profiles` (roles), `sessions`, Supabase Auth users | `tools/`: managed terraform and cf-terraforming |
| `vault`, `credentials` (ciphertext only) | `plugin-cache/` |
| `presets`, `runs`, `run_logs`, `settings`, `audit_log` | `backups/`: backup output (unless a run sets another directory); `restore-history/`: one record per restore; `approvals/`: one record per approval request |
| `monitor_targets`, `monitor_results`, `monitor_rows`, `monitor_snapshots`, `monitor_findings`, `cloudflare_alerts`, `notifications` (monitoring; notification addresses are sealed inside `settings`; `monitor_reports` is no longer written) | |

Row-level security is enabled on every table with **no policies**, so the anon and authenticated keys can read nothing. Only the server, using the service-role key, can read or write them. The browser never talks to Supabase directly.

Sessions are opaque cookies set with `HttpOnly`, `Secure` and `SameSite=Strict`. Browsers accept `Secure` cookies on `http://127.0.0.1` and `localhost`. Only their SHA-256 hash is stored. They end after at most 30 minutes idle (Settings › Sessions can set it shorter) or 12 hours. Every sign-in issues a new session ID and destroys the one the browser had. Signing out deletes the session from the database and from memory, locks the vault and expires the cookie.

Request protections:
- **HTTPS**: plain HTTP is served only on loopback (`127.0.0.1`, `localhost`, `[::1]`), where traffic never leaves the machine. On any other host ([`src/proxy.ts`](src/proxy.ts)), GET requests are redirected to HTTPS and everything else is refused. HTTPS responses carry `Strict-Transport-Security: max-age=63072000; includeSubDomains`. Behind a TLS proxy, set `X-Forwarded-Proto: https`.
- **Host check**: every request (pages and API) must use an allowed `Host`. Any host is allowed unless `CONSOLE_ALLOWED_HOSTS` lists some; set it to block DNS-rebinding pages. Mutating requests must still carry an `Origin` for the same host, and session cookies stay `SameSite=Strict` and tied to the host name you signed in on.
- **Origin check**: requests that change data must carry a matching `Origin`. The one exception is `POST /api/hooks/cloudflare` (Cloudflare's alert webhook, which sends no `Origin`): it requires the secret the console gave Cloudflare, compared in constant time, and is rate limited per address.
- **Response headers**: pages are served with a Content-Security-Policy, `frame-ancestors 'none'` and `nosniff`.
- **Error responses**: unexpected server errors return a generic message with a reference number. The details go to the server log only.

Failed sign-ins back off per account (2 s up to 30 s, so nobody can be locked out for long) and are also counted across all accounts. These counters and the API rate limits are shared by every server instance (Redis, or Supabase with migration 0014; see `RATE_LIMIT_STORE`), so they don't multiply on Vercel. On Vercel without Turnstile keys the console logs a warning: set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` there. When too many fail at once, every attempt is slowed down, which defeats password spraying without locking anyone out. Vault unlocks back off per user.

`SUPABASE_*`, `VAULT_*`, `CONSOLE_*`, `REDIS_*`, `RELAY_*`, `TURNSTILE_*` and `WORKER_GITHUB_*` variables are removed from the environment before `backup.js` and Terraform start.

> **Upgrading from the single-password version:** the old `data/vault.json` isn't migrated. Re-add credentials in **Credentials**, or use **Import .env**.

## Files

```
runner/backup.js             the backup script (see "Changes to backup.js")
supabase/migrations/         database schema
src/lib/                     auth, rbac, vault crypto, run manager, Cloudflare/S3 checks
src/app/                     pages + API routes
design-system/               UI source of truth (ui-ux-pro-max skill); tokens in src/app/globals.css
tests/                       unit tests of pure helpers (node --test)
eslint.config.mjs            lint rules (eslint-config-next)
```

### Checks

```bash
npm run typecheck   # tsc (TypeScript 7)
npm run lint        # ESLint with eslint-config-next; errors fail, warnings are listed
npm test            # unit tests in tests/*.test.ts
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all three before the build.

- **Tests** use Node's own test runner and its TypeScript support (type stripping), so they need **Node 22.18 or newer** (the console itself runs on 20.9+). [`tests/setup.mjs`](tests/setup.mjs) resolves `@/…` imports and `server-only` the way the bundler does. Test only pure helpers there: nothing starts Next.js or talks to Supabase.
- **Lint**: typescript-eslint needs the TypeScript compiler API, which TypeScript 7 does not ship. `@typescript/typescript6` (dev dependency) provides it, and `eslint.config.mjs` points the lint plugins at it; `tsc` and `next build` keep using TypeScript 7.

**Don't put a `.env` in `runner/`.** `backup.js` lets a `.env` next to it override the environment, which would bypass the vault. The console refuses to start a run while one exists.

### Changes to backup.js

`runner/backup.js` is a copy of `../backup.js`. Changes 1–4 make it run on Windows as well as Linux/macOS, changes 5–6 are security fixes, 7–8 change what gets uploaded, and 9–13 make every zone backup restorable:

1. `which()` splits `PATH` with `path.delimiter` and tries `PATHEXT` extensions.
2. `OUTPUT_DIR` is checked with `path.isAbsolute()` instead of `startsWith('/')`.
3. R2/S3 object keys always use `/`, even on Windows.
4. Log messages leave Windows paths (`C:\…`) alone instead of reading `\t`, `\0`… in them as escapes.
5. Bucket names, R2 prefix and AWS region are validated before use, and the bucket name is URL-encoded in the Cloudflare lock API path. Before this, a crafted value could redirect uploads to another host or the token's requests to other API paths.
6. After an R2 upload the bucket is never left with fewer lock rules than it had. With no rules configured, its original rules are put back instead of leaving it unlocked.
7. Uploads to R2 and S3 contain only the `.tf` files. JSON exports, state, logs and reports stay in the local backup folder.
8. Each object's Content-Type is set from its extension (`.tf` → `text/plain; charset=utf-8`). The original relied on the Unix `file` command, which doesn't exist on Windows, so everything was stored as `application/octet-stream`.
9. A ruleset whose rules can't be read (API error) is quarantined to `cloudflare_ruleset.tf.broken` instead of being kept without `rules`. Restoring such a shell would have deleted every live rule in that phase.
10. Zone IP Access rules (`cloudflare_access_rule`, zone-scoped only — the zone list also returns account rules), the zone's DNS settings (`cloudflare_zone_dns_settings`) and Universal SSL (`cloudflare_universal_ssl_setting`) are written as Terraform. Before, they were only in local JSON, so they were never uploaded and could not be restored.
11. Each zone folder gets `_backup_manifest.tf` (comments only, so it uploads with the `.tf` files): every type that failed to export and every quarantined block. Restore shows it as "This backup is incomplete", so a missing resource is never mistaken for one that didn't exist.
12. Import ID formats added for 18 zone types the backup exports (from the provider v5.28.1 docs), and three more listed as not importable — the same table is in `src/lib/tf-import-ids.ts` for Restore.
13. Still not restorable from Terraform, and listed in every manifest: uploaded custom SSL and Origin CA certificates (private keys can't be read back), Workers script code, and account-level objects zone config can reference (lists, load-balancer pools, reusable Access policies).
14. The R2 lock is put back on every way out: a cancel (on Windows the console asks over IPC first, since its forced kill can't be caught), SIGINT/SIGTERM/SIGHUP and crashes. Putting it back is retried and read back; if it fails, the run fails with a CRITICAL line listing the rules to re-apply. If the bucket's rules can't be read first, the bucket isn't unlocked. A hard SIGKILL still can't be caught.
15. Uploads are retried (network errors, 408, 429, 5xx), checked afterwards by listing the prefix (key and size), and any failed or missing file fails the run. Error lines carry only the S3 error code and message.
16. Each backup ends with `_backup-complete.json` (file list, sizes, SHA-256): locally for the whole folder, and in each bucket prefix for exactly the files uploaded there, uploaded last. Restore uses it to skip half-uploaded backups; older backups without one still restore, marked "unverified".
