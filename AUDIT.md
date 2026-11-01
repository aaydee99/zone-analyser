# AUDIT.md: performance and launch readiness (Castellan backup-console)

**Date:** 2026-11-01. **Phase 1: audit only. No project code was changed.**
**Method:** a read-only review of the source, migrations, config and the last production build log. Four parallel passes were merged here, and I checked the top findings again myself. `.env*`, `../.env` and `data/` were not opened. Nothing in production or at Cloudflare was called.
**Legal note:** everything under Legal, Consent and Personal data is a list of issues for a lawyer to review. It is not legal advice and not final compliance. No legal text, company details or figures have been invented.

## What the app is (from the code)

| | Found | Evidence |
|---|---|---|
| Framework | Next.js 16 App Router, React 19, Tailwind v4, TypeScript | `package.json:16-24` |
| Hosting | **Web** role on Vercel, which relays `/api` calls to a **worker** role running in GitHub Actions | `vercel.json`, `.github/workflows/worker.yml`, `src/lib/worker-link.ts` |
| Database / auth | Supabase Postgres over PostgREST and RPCs, with the service_role key on the server only. Supabase Auth with email and password, plus an httpOnly session cookie | `src/lib/supabase.ts:20-31`, `src/lib/auth.ts`, migrations 0001–0021 |
| ORM | None. Direct `@supabase/supabase-js` calls and SQL RPCs | `src/lib/supabase.ts` |
| Cache / rate limits | Optional Redis, then a Supabase RPC, then memory | `src/lib/cache.ts`, `src/lib/rate-limit.ts` |
| Payments | **None** | No SDK in `package.json`, no checkout, no prices |
| Email | **None.** No SMTP or email provider. Notifications go only to Slack or a webhook | `src/lib/notify.ts:78`, `src/lib/users.ts:50` (`email_confirm: true`) |
| Analytics / ads / AI | **None** | `package.json`, CSP in `src/proxy.ts:19-28` |
| Third-party script | Cloudflare Turnstile, only on login and setup, and only when keys are set | `src/components/captcha.tsx:14-27` |
| Sign-up | **No public sign-up.** Admins create users. The first super admin comes through the one-time setup token | `src/app/api/users/route.ts:8`, `src/app/api/setup/route.ts:36-46` |
| Theme | Dark only | `src/app/globals.css:94` |

**Scorecard:**

| Section | DONE | NEEDS WORK | NOT RELEVANT | UNVERIFIED |
|---|---|---|---|---|
| Performance (31 items) | 12 | 15 | 3 | 1 |
| Legal (7) | 0 | 5 | 1 | 1 |
| Consent (8) | 0 | 0 | 7 | 1 |
| Personal data (25) | 11 | 10 | 3 | 1 |
| Accessibility (21) | 10 | 10 | 1 | 0 |
| Fair design (7) | 3 | 0 | 4 | 0 |
| Claims (12) | 8 | 2 | 1 | 1 |
| IP (7) | 4 | 1 | 1 | 1 |

The per-item tables with evidence are in sections A and B below.

---

## Phase 2 status (2026-11-01)

The owner approved every fix below, including the listed edits to backup and restore code (an exception to the freeze). There is no git repository, so the changes are uncommitted. **Nothing has been deployed, and migration 0022 has not been applied.**

| # | Fix | Status | Verified by |
|---|---|---|---|
| 1 | Legal pages | **DONE (example text)** | `/privacy`, `/terms` and `/licenses` exist (`src/app/{privacy,terms,licenses}/page.tsx`). Each starts with a "draft for legal review" notice. All company facts are `[TODO: …]` placeholders in `src/lib/legal.ts`. The pages are marked noindex while any TODO is left. The footer, login and setup pages link to them. **A lawyer must review the text.** |
| 2 | Contact address | **DONE** | `src/lib/brand.ts`: no `sales@example.com` fallback. When `NEXT_PUBLIC_SALES_EMAIL` is unset, the page shows `[TODO: contact email]` and no mailto link. The variable is documented in `.env.example`. |
| 3 | Claims softened | **DONE** | "every … setting", "in minutes" and "It is built for that" are gone (`brand.ts`, `page.tsx`, README). |
| 4 | Contrast | **DONE** | Status red `#f0566a`: 4.82–5.84:1 on every surface, and 4.58:1 or more on its tints (the critical badge and danger hover went from 20% to 12%). Input border `#686c75`: 3.08–3.80:1. Hover border: 4.30–5.31:1. Demo chart bars: 3.29–3.65:1. |
| 5 | Keyboard and screen reader | **DONE** | Icon-only controls have names (`(overview)/page.tsx`, `vault/page.tsx`). The three clickable traffic rows each have a real button. Focus-visible rings on chart bars, the tag filter, the audit tab panel and the vault file picker. Console skip link with `<main id="main">` (`shell.tsx`). |
| 6 | Shell re-renders | **DONE** | `IdleCountdown` ticks only in the last 10 minutes. The shell's poll keeps the previous state when the response is unchanged (`shell.tsx`). |
| 7 | Page polls | **DONE** | New `usePoll` (`src/components/use-poll.ts`): never overlaps, pauses in hidden tabs, cancels on unmount. Used on runs, approvals and the three restore pages, with the same intervals. |
| 8 | Stale requests and cache clearing | **DONE** | `api()` accepts an AbortSignal, and a cancelled read is never cached. Search cancels the previous query. Writes clear only related cached reads, using an explicit map; anything unmapped still clears everything (`src/lib/client.ts`). |
| 9 | Cache headers and proxy | **DONE** | `next.config.ts`: `/`, `/privacy`, `/terms`, `/licenses` (HTML only, not RSC), the OG image, robots.txt and sitemap.xml get `public, max-age=0, s-maxage=300, stale-while-revalidate=60`. `/brand/*` and `/icon.svg` get `public, max-age=86400`. Everything else stays `no-store`. The proxy matcher skips `_next/static`, `_next/image`, brand assets and the icons. Checked by `tests/public-cache.test.ts`. |
| 10 | FK indexes | **DONE (not applied)** | `supabase/migrations/0022_fk_indexes.sql` and `supabase/rollbacks/0022_fk_indexes.down.sql`: indexes on `audit_log(actor_id)`, `runs(started_by)` and `credentials(created_by)`. **The owner runs it in Supabase.** |
| 11 | Retention | **PARTLY DONE** | Failed sign-ins for unknown addresses are stored masked (`j***@example.com`, `src/lib/auth.ts`). Retention purges are **not built**: the owner or a lawyer must choose the periods first. |
| 12 | Anonymise on delete | **NOT DONE (decision)** | Waiting for a lawyer to decide between anonymising and keeping the emails for security audit. |
| 13 | Fonts | **DONE** | Fira Sans 400/500/600/700 (300 dropped). Fira Code 400/500/600 (700 dropped). Fira Sans 700 is kept because `<b>` and `<th>` render at the default bold. |
| 14 | Third-party notices | **DONE** | `npm run notices` (`scripts/gen-notices.mjs`) writes `public/THIRD_PARTY_NOTICES.txt` (121 KiB: 38 packages, plus the OFL fonts, the CC-BY caniuse-lite attribution and an LGPL note). The `/licenses` page links it. **Run it again on the Linux build machine.** The LGPL and GPL texts are linked, not copied (marked TODO in the file). |
| 15 | Whole-project tracing | **DONE** | `/*turbopackIgnore: true*/` in `src/lib/backup-sources.ts` and `src/lib/syspath.ts`. **The build log now has 0 "Dynamic filesystem access" warnings.** |
| — | Fetch timeouts (A12) | **DONE** | `runner/backup.js`: 60 s on Cloudflare calls, 10 min on S3/R2 uploads, 60 s on other S3 calls. Retries are unchanged. `worker-loop.ts`: the replay fetch times out when its call expires. |
| — | Live backup log (A23) | **DONE** | Lines are batched once per animation frame. The terminal draws only the last 2,000 lines, with "Show earlier lines". Copy and download still include every line. |
| — | Favourite star (A14) | **DONE** | Optimistic toggle, rolled back on error. |

**Verification run (after all fixes):**
- Build OK. `tsc` clean, `eslint` 0 errors, unit tests 145/145.
- e2e suites, all passing:

  | Suite | Result |
  |---|---|
  | e2e | 186/187: the one failure was role-matrix rows still expecting the old rules; updated |
  | restore | 112/112 |
  | worker | 23/23 |
  | monitors | 142/142 |
  | buckets | 48/48 |
  | scale | 21/21 |
  | tags | 43/43 |
  | search | 41/41 |
  | investigate | 28/28 |
  | health | 44/44 |
  | ops | 50/50 |
  | reports | 59/59 |
  | security audit | 43/43 |

- cf-e2e: 204/215. The 11 failures already failed before this phase. Six are traffic-detail checks that fail when the month has only one day (today is the 1st). The other five are a zone-explorer accordion test, four chart-drill clicks and a shared zone-list request count. None touches these fixes.

**Still for the owner:** every `[TODO: …]` in `src/lib/legal.ts` and `NEXT_PUBLIC_SALES_EMAIL`; legal review of `/privacy` and `/terms`; applying migration 0022; retention periods; the anonymisation decision; the UNVERIFIED items (regions, DPAs, Turnstile, log retention); and running `npm run notices` on the Linux build.

---

## Ranked top-15 fix list (impact on users and legal risk, against effort)

| Rank | Fix | Why it matters | Evidence | Effort | Needs |
|---|---|---|---|---|---|
| 1 | **Legal pages scaffold:** `/privacy` and `/terms` pages made of clearly marked TODO sections, footer and login links, and the legal entity and privacy contact as TODO placeholders | A public marketing page with no privacy notice, terms or entity details is the biggest legal gap | No route (build route list); footer `src/app/page.tsx:615-624` | S (scaffold) | **Lawyer** writes the text; owner supplies the entity details |
| 2 | **Real contact address:** remove the visible `sales@example.com` fallback, or fail the build when the address isn't set | The placeholder is shown to visitors today | `src/lib/brand.ts:4,16`, `src/app/page.tsx:537` | S | Owner: the real address |
| 3 | **Soften unsupported claims:** "restore any of it in minutes", "every … setting", "It is built for that" (thousands of zones) | Unsupported performance or coverage claims are a consumer-law and trust risk | `src/lib/brand.ts:11`, `src/app/page.tsx:29-31,129,559` | S | Owner picks the wording, or provides evidence |
| 4 | **Contrast:** a lighter status red for text (#e3243f is 3.86–4.30:1), and a ≥3:1 border token for form inputs (1.30:1 today) | Error text and field edges fail WCAG 1.4.3 / 1.4.11 | `globals.css:40,74,150-153` | S | Owner OK on the new colours (#f0566a / #686c75 proposed) |
| 5 | **Keyboard and screen reader:** names for 2 icon-only controls, keyboard access to 3 clickable table rows, visible focus on chart bars, tag filter, audit tab panel and vault file picker, and a console skip link | Keyboard and screen-reader users can't reach or see these controls | `(overview)/page.tsx:195`, `vault/page.tsx:237,462`, `traffic/zone-detail.tsx:205,305,339,603`, `traffic/page.tsx:124`, `tag-filter.tsx:72-81`, `security-audit/[auditId]/page.tsx:111`, `shell.tsx:280` | S–M | — |
| 6 | **Shell re-renders:** move the 1 s idle-countdown ticker into its own component, and skip the user state update when the poll returns the same data | The whole console shell re-renders every second, and every user-context consumer re-renders on every poll | `src/components/shell.tsx:127,145`, `src/components/me.tsx:34-37` | S | — |
| 7 | **Page polls:** pause on hidden tabs, stop overlapping calls (setTimeout chain), and stop duplicating the shell poll | Each tick is a relayed call (a Vercel function plus Supabase), even in background tabs | `runs/page.tsx:29`, `approvals/page.tsx:57`, `restore/history/page.tsx:28`, `restore/page.tsx:97`, `restore/new/page.tsx:149` | S–M | The restore pages are frozen: those three need your separate yes |
| 8 | **Cancel stale requests and narrow cache clearing:** pass an AbortController through `api()`; clear only related cached reads on writes | Abandoned reads keep the worker busy, and a favourite-star toggle reloads every heavy page | `src/lib/client.ts:36` (`kept.clear()`); 0 AbortController uses; the relay supports `signal` (`worker-link.ts:212`) | S | — |
| 9 | **Cache headers and proxy:** let `/`, `/brand/*`, `/icon.svg` and the OG image be cached publicly for a short time; give the proxy a matcher that skips `_next/static` | The static landing page is forced to `no-store`, and the proxy runs on every asset | `next.config.ts:22`, `src/proxy.ts` (no `config.matcher`) | S | — |
| 10 | **Index `audit_log.actor_id`** (and optionally `runs.started_by`, `credentials.created_by`) | Deleting a user does `SET NULL`, which scans the whole, ever-growing audit log | `0001_backup_console.sql:111`; only `audit_log_at_idx` and `audit_log_action_at_idx` exist | S | **Migration 0022** |
| 11 | **Retention and failed-login data:** scheduled purge for `audit_log`, `approval_states`, `notifications`, `cloudflare_alerts`, and masking of unknown emails in `auth.login_failed` | Personal data is kept indefinitely with no stated purpose | `src/lib/auth.ts:197`; no purge in `src/lib/audit.ts` or the migrations | M | **Lawyer/owner** sets the periods; probably a migration; restore history reads `audit_log` (`restore-history.ts:145`), so the purge must be a separate job |
| 12 | **User deletion anonymisation:** replace leftover email copies with `deleted-user:<hash>` on delete | Deletion leaves email text in about 10 columns and in the `user.deleted` row | `src/lib/users.ts:109-118`, `0001:88,111-112` | M | **Lawyer** decides anonymise vs keep for security; migration or RPC |
| 13 | **Trim fonts:** Fira Sans 400/500/600 (300 is unused), Fira Code 400/600 | 45 font files are built and 7 are preloaded | `src/app/layout.tsx:7-8` | S | — |
| 14 | **Third-party notices:** generate `THIRD_PARTY_NOTICES.txt` (MIT/ISC/Apache/BSD, OFL fonts, CC-BY caniuse-lite, LGPL libvips) and link it from the footer | Licence attribution duty for bundled code | No notices file (grep) | S–M | Owner chooses where it lives |
| 15 | **Whole-project file tracing:** scope the dynamic paths so the build stops tracing every file into the server functions | Bigger deploys and slower cold starts | Build-log warning; `src/lib/backup-sources.ts:46,60,86` | S | `backup-sources.ts` is backup code, so it needs your separate yes |

**Next in line (outside the top 15):**
- Live backup log virtualization (`runs/[id]/page.tsx:48`, `terminal.tsx:135`; M; the run page is backup UI).
- Paginate `/api/cloudflare-audit` (up to 10,000 changes, `cf-audit.ts:33`) and `/api/zone-explorer` (M).
- Request IDs carried through the relay (M).
- Real-user monitoring of Core Web Vitals (S).
- A bundle-size check in CI (S).
- Timeouts on the `runner/backup.js` fetches (`:551,595,610,2039,3323`; frozen file).
- Replace the relay's polling with Realtime / LISTEN-NOTIFY (L).
- A legal acceptance record at setup (migration).
- An optimistic star/dismiss toggle (S).
- The per-instance setup token on Vercel (`setup-token.ts:14-18`).

## Fixes that need infrastructure, paid services, migrations or legal review

| Fix | Infra | New / paid service | Migration | Legal review |
|---|---|---|---|---|
| 1 Legal pages | — | — | — | **Yes** |
| 10 audit_log index | — | — | **0022** | — |
| 11 Retention purges | Worker job, or pg_cron in Supabase | — | Likely (purge RPC) | **Yes**: periods |
| 12 Anonymise on delete | — | — | Likely (RPC) | **Yes** |
| Acceptance records | — | — | **Yes** (append-only table) | **Yes**: document versions |
| Real-user monitoring | — | Vercel Speed Insights (paid on some plans) **or** a self-hosted endpoint (free) | Optional (table) | List it in the privacy notice if added |
| Relay to Realtime | Supabase Realtime enabled | — | Possibly | — |
| Regions (UNVERIFIED) | Vercel and Supabase dashboards | — | — | — |
| Brand / trademark | — | — | — | **Yes**: trademark clearance |

## Placeholders and decisions only you or a lawyer can fill in

1. **Controller or processor:** does each customer run their own copy, or do you host it? This decides which privacy notice you need, whether you need a DPA, and whether you need a sub-processor list.
2. **Legal entity:** name, registered address, company number and privacy contact, for the footer and the policies.
3. **Contact email:** the real sales/contact address for `NEXT_PUBLIC_SALES_EMAIL`.
4. **Policy text:** the privacy policy and the Terms/MSA. Is acceptance click-through at setup or by signed contract, and how are document versions numbered?
5. **Refunds:** refund and cancellation terms, if any; they'd go in the contract.
6. **Retention periods:** audit log, approvals, runs and run logs, notifications, Cloudflare alerts, findings, failed-login entries.
7. **Deleted users:** anonymise their email copies, or keep them for security audit (on what legal basis, and for how long)?
8. **DPAs and retention at vendors (UNVERIFIED):**
   - signed DPAs: Supabase, Vercel, GitHub, the Redis provider (if one is used), Cloudflare Turnstile, and Slack if you run the Slack app;
   - log and backup retention: Supabase backups/PITR, Vercel logs, GitHub Actions logs.
9. **Regions (UNVERIFIED):** Vercel › Project › Settings › Functions › Region versus Supabase › Project Settings › General › Region. If they differ, set `regions` in `vercel.json`.
10. **Turnstile (UNVERIFIED):** what it collects or stores in the browser (Cloudflare's documentation), so it can go in the privacy notice.
11. **External email tools (UNVERIFIED):** is sales or marketing email sent from any outside tool? If so, unsubscribe and suppression are needed there.
12. **Claims:** keep "in minutes", "every … setting" and "built for thousands of zones" with evidence, or let me soften them.
13. **Brand ownership:** who made the Castellan logos in `public/brand/`, is there an IP assignment, and has the name had a trademark search?
14. **Notices file:** `/licenses` page or a static file? Keep or drop the unused `sharp` binaries (LGPL) in the deploy?
15. **New colours:** OK on the status red (#f0566a proposed) and the input border (#686c75 proposed)?
16. **Frozen code:** you froze backup and restore. Fixes 7 (restore pages), 15 (`backup-sources.ts`), the backup-log virtualization and the `backup.js` timeouts all touch it, so each needs your explicit yes, or I skip them.
17. **Repository:** this folder isn't a git repository, so Phase 2's "clean git state" step needs either `git init` plus a first commit, or a snapshot before each batch.

---

# A. Performance

## A1. Items 1–16
| # | Item | Status | Evidence | Fix (effort) |
|---|------|--------|----------|--------------|
| 1 | Skeleton loading states that match the final layout | DONE | 33 route `loading.tsx` files re-export `PageLoading` (src/components/page-loading.tsx:6-17: header, 4 stats, 7x5 table). 40 of the 46 console pages also render in-page `Skeleton`/`SkeletonTable`. The 6 pages without one are forms or redirects (account, compare, investigate/*). | Optional: give the form pages (vault, settings, account) their own route skeleton, because the generic stats+table shape does not match them (S). |
| 2 | WebP/AVIF images, resized to display size, width/height set | NOT RELEVANT | No raster images. public/brand/ holds only small SVGs (352 B to 1.6 KB). The only `<img>` is inside `ImageResponse` with width/height set (src/app/opengraph-image.tsx:21), and the brand mark is an inline SVG (src/components/brand-mark.tsx:9). | n/a |
| 3 | Duplicate API calls / effects re-running; submit buttons disabled while pending | NEEDS WORK | Good: `Button` disables while `loading` (src/components/ui.tsx:38), and shared heavy reads are de-duplicated per tab (src/lib/client.ts:12-55, src/lib/zone-list-client.ts:14). Bad: page polls repeat what the shell poll already returns (shell.tsx:138 polls /api/auth/me, which includes activeRunId and pendingApprovals), and they are not paused on hidden tabs: runs/page.tsx:29 (5 s, 200 rows), approvals/page.tsx:57 (4 s, up to 300), restore/history/page.tsx:28 (5 s), restore/page.tsx:97 (10 s). `setInterval(async)` can stack up when the relay takes longer than the interval. Any POST/PUT, even a favourite star, clears every shared read (client.ts:38 `kept.clear()`). | Poll with a self-rescheduling setTimeout that pauses on `visibilitychange` (copy shell.tsx:137-144). Invalidate only the related SHARED keys on writes (S-M). |
| 4 | Search/autocomplete debounced, stale requests cancelled | NEEDS WORK | Debounced, and stale answers are ignored: zone picker waits 200 ms with a `live` flag (investigate/shared.tsx:100-109), and the same debounce+live pattern is used in monitor-view.tsx:64,78-81, lists, logpush, health and zones/tags. But nothing is aborted: there are 0 `AbortController` uses in src/app/console and src/components. The relay already honours `req.signal` (src/lib/worker-link.ts:212), so an abandoned query keeps a Vercel function polling and the worker working. /console/search `load` has no stale guard (search/page.tsx:55-59). | Pass an AbortController signal through `api()`, abort it in effect cleanup, and add a live/seq guard to search `load` (S). |
| 5 | List endpoints paginated with a server-side max page size | NEEDS WORK | Most are capped at 200: monitors/findings/route.ts:19, monitors/[check]/rows/route.ts:18, reports/route.ts:12, security-audit/route.ts:22, investigate/zones/route.ts:15, zone-search.ts:96. Some return everything: /api/zone-explorer sends the whole zone list (route.ts:29), /api/cloudflare-audit sends up to 10,000 changes in one JSON (cf-audit.ts:33 `MAX_TOTAL`), /api/restore/history, /api/users (users/route.ts:6) and /api/approvals (slice 300) have no offset. /api/runs allows `limit` up to 5,000 (runs/route.ts:9). | Add offset/limit (max 200) to cloudflare-audit and zone-explorer list responses, or virtualise the client lists. Lower the runs MAX (M). |
| 6 | Static assets behind a CDN; personalised responses never CDN-cached | NEEDS WORK | Personalised data is safe: next.config.ts:22 sends `Cache-Control: no-store` on `/:path*`, CLOUDFLARE.md:172-195 caches only `/_next/static/` (immutable), and the SSE stream sends no-store (runs/[id]/stream/route.ts:10). The waste is on public pages: the landing page `/` is prerendered static (build.log:263 `○ /`) but still gets no-store, as do public/brand/*.svg and /icon.svg. src/proxy.ts has no `config.matcher`, so the proxy runs on every static asset too (src/proxy.ts:4). | Exclude `/`, `/brand/*`, `/icon.svg`, `/opengraph-image` from the no-store header and give them a short public max-age. Add a proxy matcher that skips `_next/static` (S). |
| 7 | Slow work (email, PDFs, image processing, bulk calls) in a background queue | DONE | Jobs run on the worker through the Supabase queue (worker-link.ts:8-13). Long Cloudflare reads use `inBackground` with progress and abandonment (src/lib/bg-job.ts:1-9). Monitoring runs through monitor-queue.ts. Reports answer at once and finish later (reports/[id]/run/route.ts:9-11). Notifications go out in batches (notify.ts:9-16). There is no email and no PDF generation. | n/a. Note that bg-job state is in process memory, so it is lost if the worker restarts. |
| 8 | N+1 queries (DB calls inside loops, .map()) | NEEDS WORK | Request paths batch well: monitor-store.ts:64,144,165 work in chunks of 500, and zone-meta.ts:162 calls a bulk RPC per chunk. The search-index rebuild calls the `zone_search_replace` RPC once per zone, one at a time (zone-search.ts:314-321 drift snapshots in pages of 50, 336-345 per zone per check). It is background-only, but it grows linearly with zone count. | Gather several zones into one RPC call (array payload), or run 4-8 at once (S, low priority). |
| 9 | Brotli/Gzip on text responses without breaking streaming | DONE | next.config.ts does not set `compress: false` (default gzip on `next start`). Vercel and Cloudflare compress at the edge, with Brotli on per CLOUDFLARE.md:367. The SSE route sets `text/event-stream` (stream/route.ts:10) and flushes per event. | Optional hardening: add `no-transform` to the SSE Cache-Control so no proxy can buffer or compress the stream (S). |
| 10 | Caching of hot reads, with per-user cache keys where data is per user | DONE | src/lib/cache.ts:107-125 is a shared cache (Redis sealed with AES-GCM, or memory) with in-flight de-duplication. Keys are scoped by token where the data depends on the token, e.g. `cf:token-accounts:${tag(token)}` (providers.ts:39,59) and `cf:account-zones:${accountId}:${tag(token)}` (cf-audit.ts:141). Org-wide data is checked with `perm` in `route()` (http.ts:144) before the handler reaches the cache. Per-user data (/api/me/*) is not cached. The session/profile is cached in process (auth.ts:257-258). | n/a |
| 11 | Unused or heavy dependencies | DONE | 7 runtime deps, all used: redis (cache.ts:3), lucide-react (80 imports), @supabase/supabase-js, server-only, next/react. `@typescript/typescript6` is used by eslint.config.mjs:8. Minor: Fira Sans weight 300 is loaded (src/app/layout.tsx:7) but no `font-light` or weight-300 rule exists, so 9 font weights ship with 7 woff2 preloaded. | Drop weight '300' from Fira_Sans, and check whether Fira_Code needs all 4 weights (S). |
| 12 | Timeouts on every outbound HTTP/SDK call; no blind retries on non-idempotent sends | NEEDS WORK | Good: Supabase has a global 30 s timeout (supabase.ts:23-25), Cloudflare 30 s (cf-read.ts:100), GitHub 8-10 s (worker-wake.ts:72,93,153), Slack/webhook 15 s (notify.ts:32, hooks/slack/route.ts:77). Slack sends claim before sending and are not retried blindly (notify.ts:9-16). Gaps: runner/backup.js has no timeout on `fetch` at :551 (cfApi), :595, :610, :2039 and :3323 (S3/R2). worker-loop.ts:269 (local replay fetch) has no timeout. Redis commands have only a connect timeout (cache.ts:40). backup.js `cfApi` retries 429/5xx for every method, including the PUT at :3129 (idempotent, so acceptable). | Add `signal: AbortSignal.timeout(60_000)` to the backup.js fetches. The owner's memory says backup code is frozen, so this needs their sign-off. Add a timeout to the worker-loop replay that matches `expires_at` (S). |
| 13 | AI responses streamed | NOT RELEVANT | No AI provider. grep for openai/anthropic/gemini over src, runner, scripts and package.json finds only substring false positives. | n/a |
| 14 | Optimistic UI on small, low-risk actions only | NEEDS WORK | No optimistic updates anywhere (0 `useOptimistic` or optimistic patterns). Risky actions such as restore, approvals and purge correctly wait for the server. Small toggles also wait for a round trip: the favourite star (quick-zones.tsx:87-90) and finding dismiss/restore (monitor-view.tsx:193-199). | Flip the star and the dismiss state at once and roll back on error. Keep everything else as it is (S). |
| 15 | Below-the-fold images lazy-loaded, hero prioritised | NOT RELEVANT | No `<img>` or `next/image` on the landing page. The hero is a canvas/SVG animation that pauses off-screen and on hidden tabs (hero-field.tsx:118-132), and reveal/count-up use IntersectionObserver (reveal.tsx:25, count-up.tsx:22). | n/a |
| 16 | Sequential awaits that could run in parallel; frontend fetch waterfalls | NEEDS WORK | Mostly parallel already (50 `Promise.all` in src/lib, e.g. route() rate limits at http.ts:138-141, getMe at auth.ts:260, and the page loads in overview/page.tsx:31 and backup/page.tsx:238). Remaining serial steps: `readZoneList` reads each credential and each page of 50 one after another (zone-explorer.ts:57-90). `liveState` chains relayJson, then retireIfOutdated, then startingSince, then startProgress (live-state.ts:44-51); the layout caps this at 400 ms (layout.tsx:13,30). GET routes await audit inserts before answering (e.g. cloudflare-audit/route.ts:14, zone-explorer/[id]/report/route.ts:11). 42 of 46 console pages are `'use client'` and fetch only after hydration, so each page goes HTML, then JS, then API, then relay. | Read credentials in parallel (separate token budgets), and after page 1 fetch the remaining pages in parallel. Run retireIfOutdated alongside relayJson. Move view-audit writes into `after()` (S-M). |

### Most impactful performance problems

1. **Every Vercel API call is relayed through a Supabase polling loop.** `send()` inserts a `worker_calls` row and then polls it with a select every 25 ms, backing off to 250 ms, for up to 280 s (src/lib/worker-link.ts:164,206-215). The function stays alive the whole time (vercel.json `maxDuration: 300`). A sleeping worker adds a 45 s wake wait (worker-link.ts:109,118-123). Even a trivial read costs at least an insert, several polls, a decrypt and a delete, and long calls make about 4 selects per second. Fix: use Supabase Realtime or Postgres LISTEN/NOTIFY to learn when the answer is ready, or back off further after the first second (M).
2. **Page polls stack up, ignore hidden tabs, and duplicate the shell poll.** runs/page.tsx:29 (5 s, 200 runs per poll, MAX 5,000), approvals/page.tsx:57 (4 s, 300 rows), restore/history/page.tsx:28 (5 s), restore/page.tsx:97 (10 s) and restore/new/page.tsx:149 (1.5 s) all use `setInterval(async)` with no visibility pause. Every tick is a relayed call (item 1), and the shell already polls activeRunId and pendingApprovals (shell.tsx:138).
3. **The whole project is traced into the server functions.** build.log:21-260 shows "Dynamic filesystem access causes tracing of the whole project" from src/lib/backup-sources.ts:46,60,86, imported from the console layout, instrumentation and the API routes. The Vercel function bundles grow, which slows deploys and cold starts. Fix: scope the paths statically or add `/*turbopackIgnore: true*/` (S).
4. **Large unpaginated payloads.** /api/cloudflare-audit can return 10,000 changes (cf-audit.ts:33). /api/zone-explorer returns every zone, and the page renders the whole grouped list client-side with no virtualisation (zone-explorer/page.tsx:397-406). On top of that, large relayed answers are fetched in 512 KB chunks, one Supabase select per chunk (worker-link.ts:29,242-253).
5. **Any write wipes the per-tab shared cache, and stale requests are never aborted.** client.ts:38 runs `kept.clear()` on every POST/PUT/PATCH/DELETE, including a favourite toggle, so the next page view reloads heavy reads (zone-explorer, traffic, cloudflare-audit) through the relay. With 0 AbortControllers in client code, abandoned reads keep running on Vercel and the worker even though the relay supports `req.signal`.
6. **Smaller always-on costs.** The proxy has no matcher, so it runs on every `_next/static` asset (src/proxy.ts:46). The static landing page `/` is forced to `no-store` (next.config.ts:22), so neither the browser nor Cloudflare can cache it. The Shell re-renders every second for a clock (shell.tsx:145). Fira Sans weight 300 ships but is never used (layout.tsx:7).

## A2. Items 17–31
| # | Item | Status | Evidence | Fix (effort, migration?) |
|---|------|--------|----------|--------------------------|
| 17 | Missing indexes (WHERE/JOIN/ORDER BY, FKs) | NEEDS WORK | The hot paths are indexed (worker_calls_queued_idx 0009:16, monitor_targets_due_idx 0011:28, monitor_findings_* 0011:73-76, zone_search_* 0016:44-60, zone_audits_* 0021:29-33). Gaps: the FK `audit_log.actor_id` (0001:111) has no index, and `deleteUser` (src/lib/users.ts:116) cascades `ON DELETE SET NULL` into it, so each delete scans the whole audit_log. `runs.started_by`, `credentials.created_by`, `presets.created_by/updated_by` have no index either (small tables). `listAudit` does `action LIKE 'x%' ORDER BY id DESC` (src/lib/audit.ts:22-25), and `audit_log_action_at_idx (action, at desc)` (0008:5) serves the prefix match only under C collation and does not match the ORDER BY id. | `create index concurrently audit_log_actor_idx on audit_log(actor_id)`. Optionally add `(action text_pattern_ops, id desc)`, and indexes on runs(started_by) and credentials(created_by). (S, migration 0022) |
| 18 | Request tracing, no secrets/PII in logs | NEEDS WORK | No OpenTelemetry, `@vercel/otel`, traceparent or request-id anywhere in src/package.json. The only correlation is a random 4-byte ref per 500 error (src/lib/http.ts:102-103). Web→worker relay calls (worker-link.ts:206) are not tied to a log id. Logs are mostly clean: rate-limit keys are SHA-256 hashed (rate-limit.ts:44), and there are 59 console.* calls with no token/header dumps. But `console.error(err)` logs whole error objects (http.ts:99,103), and the first-run setup token is printed to stdout (setup-token.ts:19-27), which lands in Vercel logs. | Add a request id in `route()`, return it as `x-request-id`, pass it through the relay into worker logs, and log `{ref, route, status, ms}` only. Optionally add `@vercel/otel` with attribute redaction. (M, no migration) |
| 19 | Server and DB regions match | UNVERIFIED | vercel.json has no `regions` and no `preferredRegion` in src/app. The worker runs on `runs-on: ubuntu-latest` (worker.yml), which has no region control. Every web request goes through PostgREST, and relayed calls go Vercel→Supabase→worker→Supabase→Vercel. | Owner: compare Vercel › Project › Settings › Functions › Region with Supabase › Project Settings › General › Region (e.g. iad1 ↔ us-east-1). If they differ, set `"regions": ["<match>"]` in vercel.json. (S, no migration) |
| 20 | Rendering mode per route; no private data in SSR HTML | DONE | build.log: `/`, `/console/login`, `/console/setup`, `/console/unlock` are static (○) and every other `/console/*` route is dynamic (ƒ). 45 of 50 page.tsx files are `'use client'` and fetch through /api. The only data rendered on the server is the signed-in user's own id/email/role/permissions (`console/(app)/layout.tsx:31-36`), sent `no-store`. | — |
| 21 | Third-party scripts deferred / on interaction | DONE | Turnstile is the only third-party script. It is injected `async` from a `useEffect`, only when a site key exists and only on login/setup (src/components/captcha.tsx:14-27). The CSP allows it only when enabled (src/proxy.ts:19-24). There is no next/script or analytics tag. | — |
| 22 | Per-page code splitting, heavy components on demand | DONE | App Router splits per route. Runtime deps are only next/react/lucide/supabase/redis (package.json), with no chart or editor libraries. The largest client chunks are framework code (0yzw_… 235 KB holds react-dom; next is 169 KB). There is no `next/dynamic`, but nothing heavy needs it. | Optional: lazy-load big dialogs on the 600–700-line pages (backup, zone-explorer, vault). (S) |
| 23 | Long lists virtualized | NEEDS WORK | Most lists are paged with `Pager`/`limit` (compare, reports, security-audit, zones/tags, logpush), and the worker tail is capped (`KEEP = 1_000`, worker-logs/page.tsx:17,123). The exception is the live backup log: `setLines((ls) => [...ls, line])` per SSE event (runs/[id]/page.tsx:48), and `Terminal` maps every line (terminal.tsx:66,135) with no windowing (rows are `memo`, but each new line still means an O(n) copy and reconcile). | Batch SSE lines with requestAnimationFrame, and window the Terminal (render the last ~2,000 lines, or use a simple virtual list), or apply `content-visibility:auto` to line blocks. (M, no migration) |
| 24 | SELECT * / sensitive fields to client | DONE | Sensitive tables use explicit column lists: profiles (auth.ts:127), credentials `CRED_COLS` (vault.ts:337). `summarize()` swaps every secret field for `{set, hint}` before it reaches the client (vault.ts:355-362). sessions are keyed by `token_hash` and never returned. The remaining `select('*')` calls are on non-secret tables (workers worker-link.ts:56, zone_templates compare.ts:116/122, cloudflare_alerts/notifications monitor-store.ts:293,306, monitor_snapshots drift.ts:51, monitor_targets monitor-queue.ts:436) and are mapped server-side. | Optional: replace those `*` with column lists so new columns are not exposed by default. (S) |
| 25 | One shared DB client | DONE | `db()` keeps a single service-role client on `globalThis.__cfDb` with a 30 s fetch timeout (src/lib/supabase.ts:20-31). Access goes over HTTP (PostgREST), so there is no Postgres pool to exhaust. A fresh anon client per sign-in check is intentional (supabase.ts:27). | — |
| 26 | Unnecessary re-renders | NEEDS WORK | `Shell` holds a 1 s `setNow` ticker (shell.tsx:145) only for the idle countdown shown in the last 10 min, so the whole shell (nav, `ZoneSearchBox`, banners) re-renders every second. The 20 s / 4 s poll does `setMe(await api(...))` (shell.tsx:127) with a new object every time, so the `useMemo` in MeProvider (me.tsx:34-37) changes identity and every `useMe()` consumer re-renders even when nothing changed. | Move the countdown into its own `<IdleCountdown expiresAt>` component (tick only under 10 min). In refresh, keep the previous state when its JSON is equal. Optionally split the static user/permissions from the live job state into two contexts. (S, no migration) |
| 27 | Cache-Control headers | DONE | `Cache-Control: no-store` on `/:path*` (next.config.ts:22). This covers HTML, RSC and all /api responses. Downloads and SSE set `no-store` explicitly (zone-routes.ts:33, runs/[id]/stream/route.ts:10). Next.js forces `public, max-age=31536000, immutable` on hashed /_next/static files (config cannot override it). | Optional: let the static public landing `/` be CDN-cacheable (e.g. `public, max-age=0, s-maxage=300`) instead of no-store. Owner can confirm immutable with `curl -I` on a /_next/static file. (S) |
| 28 | Multi-instance ready | DONE | Sessions live in Supabase (0001 sessions). Rate limits use Redis → Supabase RPC on Vercel, with memory only as a fallback (rate-limit.ts:54-64). Monitor units are leased atomically (`monitor_claim` with `lease_until`, 0012:19-26). Reports use `report_claim` RPC (report-store.ts:127). Jobs use `job_lock_acquire` (0013). There is a single worker (`concurrency: console-worker`, worker.yml), and the health endpoint is /api/health (DB + worker). Caveat: the first-run setup token is per-process memory/disk (setup-token.ts:14-18), so on Vercel several instances can each mint a different token. | Optional: take the setup token from an env var or a Supabase row when on Vercel. (S) |
| 29 | Fonts self-hosted, 2–3 weights, swap | NEEDS WORK | Self-hosted through next/font (default `display: swap`; page.tsx:25 sets swap explicitly), and the CSP is `font-src 'self'`. But Fira Sans loads 5 weights (`300…700`, layout.tsx:7), Fira Code 4 weights (layout.tsx:8), and the landing page adds Archivo. That is 45 woff2 files in `.next/static/media`. | Cut to Fira Sans 400/500/600 and Fira Code 400/600, or use variable fonts. Set `preload: false` on Fira Code. (S, no migration) |
| 30 | RUM of Core Web Vitals | NEEDS WORK | No `useReportWebVitals`, `@vercel/speed-insights` or web-vitals package (grep of src and package.json found nothing). | Enable Vercel Speed Insights (same-origin /_vercel/speed-insights fits the CSP), or add `useReportWebVitals` posting to a small /api endpoint. (S, no migration) |
| 31 | Performance budgets / CI checks | NEEDS WORK | .github/workflows/ci.yml runs audit, typecheck, lint, test and build only. There is no bundle-size, Lighthouse or size-limit step. Build warnings about whole-project tracing (backup-sources.ts:46,60,86, syspath.ts:35 in build.log) are not caught either. | Add a CI step that checks the total size of `.next/static/chunks` (or size-limit with a threshold), and Lighthouse CI for `/` and `/console/login`. Optionally fail on the tracing warnings. (S–M, no migration) |

## Most impactful problems

1. **Shell re-renders every second, and every 20 s poll re-renders all `useMe()` consumers.** `setInterval(() => setNow(Date.now()), 1000)` (src/components/shell.tsx:145) and `setMe(await api(...))` with no equality check (shell.tsx:127) invalidate the memoized context (src/components/me.tsx:34-37). Fix: isolate the countdown and skip equal states (S).
2. **No request tracing or correlation across web → Supabase → worker.** The only correlation is a per-error 4-byte ref (src/lib/http.ts:102-103). A slow or failed relayed call cannot be followed from Vercel logs to the worker log. Fix: a request id in `route()`, carried through `relay()` (M).
3. **Live backup log is unbounded and not virtualized.** `[...ls, line]` per SSE event (src/app/console/(app)/runs/[id]/page.tsx:48), and every line is rendered (src/components/terminal.tsx:66,135). Large runs give O(n²) work and a heavy DOM. Fix: batch with rAF and window the list (M).
4. **Region alignment is not pinned.** There is no `regions` in vercel.json, and the worker runs on GitHub-hosted runners in an unknown region. Each relayed call makes several Supabase round trips, so a region mismatch multiplies latency. The owner must compare the Vercel function region with the Supabase project region (S).
5. **Fonts: 9 static weights plus Archivo (45 woff2 files).** src/app/layout.tsx:7-8. Trim to 2–3 weights per family (S).
6. **Unindexed FK `audit_log.actor_id`.** supabase/migrations/0001_backup_console.sql:111. User deletion (src/lib/users.ts:116) does `SET NULL` with a sequential scan of the ever-growing audit_log. Fix: `create index concurrently` in a new migration 0022 (S, migration).

Also: no RUM (30) and no performance budget in CI (31). Both are cheap to add.

# B. Launch readiness

## B1. Legal, consent, personal data, vendors

Read-only audit, 2026-11-01. No project file was changed. `.env*` and `data/` were not opened (env names come from `.env.example` key names only).

**Context that changes the picture:**
- The product is offered as a deployment *inside the customer's own* Supabase, Vercel/GitHub or server, and their own buckets. See `src/app/page.tsx:549` ("your data stays in your Supabase project and your own buckets") and the FAQ at `page.tsx:567`. So for console data you are probably the customer's **processor**, or not involved at all. For the public landing page and sales email you are a **controller**. A lawyer has to confirm which model applies, because it decides whether you need a privacy policy, a DPA, or both.
- **There is no public sign-up.** Users are created only by admins (`src/app/api/users/route.ts:8`, perm `users:manage`). The first super admin is created through `/api/setup`, which needs the one-time setup token and is refused once any user exists (`src/app/api/setup/route.ts:36-46`). The setup page and the system checks also tell the owner to turn Supabase public sign-up off (`src/app/console/setup/page.tsx:95`, `src/lib/runner.ts:593`).
- **No email is ever sent.** There is no SMTP or email SDK. Users are created with `email_confirm: true` (`src/lib/users.ts:50`). Notifications go only to a Slack webhook or a generic webhook (`src/lib/notify.ts:78`). The brief's "email notifications" claim did not hold up.
- **No AI provider, analytics, ad or tracking script.** Not in deps (`package.json:16-24`) and not in the CSP (`src/proxy.ts:19-28`).
- **The audit log does NOT record IPs** (`src/lib/audit.ts:10-12`: actor_id, actor_email, action, target, details). The brief's claim did not hold up. Client IPs are used only as SHA-256-hashed rate-limit keys (`src/lib/rate-limit.ts:45`). `sessions.ip` exists in the schema (`supabase/migrations/0001_backup_console.sql:31`) but is never written (`src/lib/auth.ts:214-215` writes only user_agent).

### 1. LEGAL

| Item | Status | Evidence | Fix / what's needed |
|---|---|---|---|
| Privacy policy page exists | NEEDS WORK | There is no `/privacy` route: the full route list has only `/`, `/console/*` and `/api/*`. The footer links are just Sign in / Contact sales / FAQ (`src/app/page.tsx:616-618`). | Add a `/privacy` page and link it from the footer and the login page. The text must come from the owner or a lawyer. |
| Privacy policy matches data and vendors | NOT RELEVANT (yet) | There is no policy to compare. | When one is written, base it on the "Personal data" and "Vendors" tables below: staff email, name, user agent, audit actions, Slack IDs, zone contact free-text, Cloudflare actor emails and IPs, visitor IPs in Ray/WAF lookups, Turnstile. |
| Terms of service | NEEDS WORK | No `/terms` route or link anywhere (`src/app/page.tsx:606-627`). | You need a ToS or MSA. Deals are sales-led ("Talk to us", `page.tsx:536`), so a signed contract may replace click-through terms. The lawyer decides. |
| Sign-up acceptance step | NEEDS WORK | Neither `src/app/console/login/page.tsx:69-74` nor `src/app/console/setup/page.tsx:109-129` has a checkbox or a terms link. | At least add an "I accept the Terms / have read the Privacy notice" checkbox to first-run setup (`/console/setup`). That is the one point where the customer's super admin "signs up". Admin-created users may be covered by the customer's own employee notice. |
| Acceptance records (user, doc version, timestamp, method, append-only) | NEEDS WORK | No acceptance table in `supabase/migrations/*.sql`. `audit_log` can be deleted or updated by service_role and has no append-only trigger (`0001_backup_console.sql:108-117`). | Add a `legal_acceptances(user_id, doc, version, accepted_at, method, user_agent)` table with an insert-only trigger, or record `legal.accepted` in the audit log and block update/delete on that table. |
| Refund policy | UNVERIFIED | No public prices. Plans are bespoke over email (`src/app/page.tsx:533-537`). | The owner decides whether refunds go in the contract or order form. You only need a public policy if you start taking self-serve payments. |
| Business contact details in footer/app | NEEDS WORK | The only contact is `BRAND.salesEmail`, which falls back to the placeholder `sales@example.com` (`src/lib/brand.ts:4,16`). The footer has no legal entity name or address (`src/app/page.tsx:621-624`). | Set `NEXT_PUBLIC_SALES_EMAIL` at build time. Add the legal entity name, registered address and a privacy contact to the footer, as local law requires. Only the owner can supply these. |

### 2. CONSENT

Cookies and storage the app sets:

| Key | Type | Set at | Purpose | Strictly necessary? |
|---|---|---|---|---|
| `cfbc_session` | Cookie: httpOnly, Secure, SameSite=Strict, 12 h | `src/lib/http.ts:14,179-184` | Login session (only its SHA-256 is stored in `sessions`) | Yes |
| `backup.request` | sessionStorage | `src/app/console/(app)/backup/page.tsx:336` | Pending approval ID | Yes (functional, signed-in only) |
| `restore.session` | sessionStorage | `src/app/console/(app)/restore/new/page.tsx:136` | Resume a restore session | Yes (functional) |
| `traffic.choice` | localStorage | `src/app/console/(app)/traffic/page.tsx:309,361` | Last traffic view chosen | Preference, signed-in staff only. Generally exempt as user-requested functionality. |
| `zx.openAccounts` | localStorage | `src/app/console/(app)/zone-explorer/page.tsx:421` | Which account groups are expanded | Preference (as above) |
| Turnstile (third-party) | Script + iframe from challenges.cloudflare.com, only on login/setup when keys are set | `src/components/captcha.tsx:14`, `src/proxy.ts:20-28` | Bot check | Security, usually treated as necessary. What Cloudflare stores in the browser is UNVERIFIED (see below). |

The landing page sets no cookies or storage. It is static (`src/app/page.tsx:21`), and its fonts are self-hosted by `next/font` at build time (`page.tsx:24`).

| Item | Status | Evidence | Fix / what's needed |
|---|---|---|---|
| Cookie banner with equal accept/reject | NOT RELEVANT | Every key above is strictly necessary or a signed-in UI preference. No analytics or ad cookies. The landing page is cookie-free (`src/app/page.tsx:21`). | No banner needed today. Still list the keys in the privacy notice. If analytics are ever added, this becomes NEEDS WORK. |
| Analytics/ad scripts gated until consent | NOT RELEVANT | No analytics deps (`package.json:16-24`). The CSP allows scripts only from 'self' and, optionally, challenges.cloudflare.com (`src/proxy.ts:23`). | None. |
| Turnstile storage / data | UNVERIFIED | The script loads on login/setup only (`src/components/captcha.tsx:14-20`). The visitor IP goes to the siteverify call (`src/lib/captcha.ts:29`). | The owner should check Cloudflare's Turnstile privacy terms and whether Turnstile stores anything in the browser, then list it in the privacy notice. |
| Global Privacy Control | NOT RELEVANT | No sale/share of data and no tracking. No `Sec-GPC` handling (grep found none). | Not required while nothing is sold or shared. Revisit if analytics or ads are added. |
| Marketing opt-in separate/unticked | NOT RELEVANT | No marketing sign-up form exists. The only inputs are login/setup/user admin (`login/page.tsx:69-74`). | If a newsletter or "contact us" form is added, give it its own unticked box. |
| Unsubscribe + List-Unsubscribe on marketing email | NOT RELEVANT | The app sends no email (no SMTP/ESP in `package.json` or source). `notify.ts:78` posts only to Slack or webhooks. | If sales email is sent from another tool (e.g. a CRM), that tool must provide it. Owner to check. |
| Suppression list | NOT RELEVANT | No email sending. | As above. |
| Marketing vs transactional separation | NOT RELEVANT | The only outbound messages are operational findings/reports to admin-configured Slack or webhook (`src/lib/notify.ts:62-133`). | None. |

### 3. PERSONAL DATA

| Item | Status | Evidence | Fix / what's needed |
|---|---|---|---|
| Unnecessary form fields | DONE | Setup asks for token, name (optional), email and password (`src/app/console/setup/page.tsx:109-129`). Login asks for email and password (`login/page.tsx:69-74`). Admin user creation asks for email, name, role and password (`src/lib/users.ts:43`). | Minor: admins set the user's first password, so the admin knows it (`users.ts:50`). Consider forcing a change at first login. |
| Unnecessary browser permissions | DONE | `Permissions-Policy: camera=(), microphone=(), geolocation=()` (`next.config.ts:19`). | None. |
| Free-text personal data fields | NEEDS WORK (disclose) | `zone_meta.owner/contact/notes` free text, up to 200 chars (`supabase/migrations/0015_zone_meta.sql:15-17`). `slack_users.note` (`0020_reports.sql:67`). | Name these in the privacy notice or DPA ("customer-entered contact details"). They are deleted by hand only. |
| Secrets in run logs | DONE | Every runner line passes `redactor(run.secrets)` before memory, `run_logs` or the stream (`src/lib/runner.ts:97-100,329,349`). | Optional: add a test that a token-shaped string never reaches `run_logs`. |
| Secrets in audit details | DONE | A password change records only `password: 'reset'` (`src/lib/users.ts:92`). Vault actions record field names, not values (`src/lib/vault.ts:497,512`). The Global API Key is never in the audit log (`README.md:232`). | None. |
| Personal data in audit log: login failures | NEEDS WORK | `auth.login_failed` stores whatever was typed as the email, even for unknown accounts (`src/lib/auth.ts:197`). That can be a mistyped password or a third party's address, and it is kept forever. | Store a hash or a masked value for unknown users, or set a short retention for `auth.*` rows. |
| Personal data in audit log: Slack | NEEDS WORK (disclose/retain) | `slack.command` stores the Slack user ID, team and up to 200 chars of the command text (`src/app/api/hooks/slack/route.ts:63`). | Include in retention policy. |
| Setup token in server logs | DONE (by design) | Printed once to the server console (`src/lib/setup-token.ts:20`) and cleared after setup (`src/app/api/setup/route.ts:45`). On Vercel this lands in Vercel logs. | Mention in OPERATIONS. The token stops working once setup is done. |
| console.error with personal data | DONE | No console.* call logs email, token, password or IP (grep of `console.(log|info|warn|error)` with those words found only lock keys, `src/lib/job-lock.ts:151`). Errors are logged as objects (e.g. `hooks/slack/route.ts:74`). | Owner should spot-check Vercel / GitHub Actions log output after launch. |
| Worker tail logs | DONE (short-lived) | The short form drops request headers, cookies and client IP (`src/lib/worker-tail-types.ts:61`, `src/lib/worker-tail.ts:20`). Sessions last 10 min (`worker-tail-types.ts:5`) and keep at most 1,000 events (`:11`, `worker-tail.ts:206`). Events are deleted on stop (`worker-tail.ts:245`), and stopped or expired sessions are purged (`:258-259`). | The customer's own `console.log` text and request URL can still contain personal data. Mention this in the DPA. |
| Retention: sessions | DONE | Expired sessions are deleted at each login (`src/lib/auth.ts:219`). 12 h max cookie (`src/lib/http.ts:15`). | Sessions also store `user_agent`. Disclose it. |
| Retention: rate limits | DONE | Keys are SHA-256 hashed (`src/lib/rate-limit.ts:45`). Rows are deleted 1 h after reset (`supabase/migrations/0014_rate_limits.sql:37`). | None. |
| Retention: worker calls / relay | DONE | `worker_calls` are purged 5 min after expiry (`src/lib/worker-loop.ts:367-369`). Relay nonces too (`0014_rate_limits.sql:68`). | None. |
| Retention: report runs / zone audits | DONE | Each report keeps the newest 50 runs (`src/lib/report-types.ts:25`, `0020_reports.sql:95`). Zone audits are trimmed (`0021_zone_audits.sql:52`). | None. |
| Retention: audit_log | NEEDS WORK | No delete, cron or TTL anywhere (`supabase/migrations/*`, `src/lib/audit.ts`). Rows grow without limit. | Decide a period (owner/lawyer) and add a scheduled delete, e.g. in the worker `purge()` or pg_cron. Note: restore history reads `audit_log` (`src/lib/restore-history.ts:145`) and backup/restore code is frozen, so do the purge as a separate job only. |
| Retention: approvals | NEEDS WORK | `approval_states.updated_by` (email text) is never deleted (`supabase/migrations/0013_worker_locks.sql:25-30`). | Add a purge of terminal-state rows older than N days. |
| Retention: run logs / runs | NEEDS WORK | Runs and `run_logs` are deleted only by hand (`src/lib/runner.ts:526`). `runs.started_by_email` is kept (`0001_backup_console.sql:88`). | Choose a retention period or document "kept until deleted by the customer". |
| Retention: notifications, alerts, findings | NEEDS WORK | Only inserts and reads for `notifications` and `cloudflare_alerts` (`src/lib/monitor-store.ts:289,302`), with no purge. Raw Cloudflare alert payloads are stored in `data`. | Add a TTL purge. |
| Data export (DSAR) endpoint | NEEDS WORK | No self-service export of a user's own data. `/api/auth/me` returns only the profile. The CSV exports are Cloudflare data (`src/app/api/cloudflare-audit/export.csv`). | Document a manual SQL procedure (profile, sessions, audit_log by actor_id/actor_email, slack_users, favourites, saved views, api_saved_queries), or add an admin-only export. |
| Account deletion really deletes/anonymises | NEEDS WORK | `deleteUser` deletes the auth user and cascades to profile, sessions, favourites, views, saved queries, tail sessions and slack_users (`src/lib/users.ts:109-118`, FKs `on delete cascade`). But email text copies remain: `audit_log.actor_email` (FK only `set null`, `0001:111-112`), `runs.started_by_email` (`0001:88`), `approval_states.updated_by`, `zone_meta.updated_by`, `zone_templates.created_by/updated_by`, `report_definitions.created_by/updated_by`, `report_runs.requested_by`, `worker_wakeups.requested_by`, `slack_users.added_by`. The `user.deleted` audit row itself stores the deleted email (`users.ts:118`). | Either anonymise these columns on delete (replace the email with `deleted-user:<id-hash>`), or keep them deliberately for security audit under a documented legal basis. Lawyer to choose. |
| Deletion reaches vendors | UNVERIFIED | Supabase Auth user removed (`users.ts:116`). Nothing in Slack, R2/S3 (backups hold Cloudflare config, which may include Cloudflare user emails) or Redis is touched. | Owner: confirm Supabase backups/PITR retention. Confirm that Redis cache entries (2 min, `src/lib/cf-audit-cache.ts`) expire. Decide whether bucket backups fall under deletion requests. |
| Self-service account deletion | NOT RELEVANT | B2B staff accounts are managed by the customer's admins. Users cannot delete themselves (`users.ts:111`). | Say "contact your administrator" in the privacy notice. |
| Third-party personal data processed | NEEDS WORK (disclose) | Cloudflare audit actor email and IP (`src/lib/cf-audit.ts:226-230`). End-visitor IP, country and ASN in Ray/WAF lookups (`src/lib/ray-lookup.ts:36-44`), which can also be posted to Slack by `/castellan ray` (`src/lib/slack-commands.ts:16`). | Cover it in the DPA and processing description: the customer is controller and the console is a tool. |
| Age handling | NOT RELEVANT | Staff-only B2B console. No public sign-up (see Context). | Optional "not for under-16s / business use only" line in the ToS. |
| Data sent to AI providers | NOT RELEVANT | No AI SDK or host (grep for openai/anthropic/gemini/llm found nothing). | None. |

### 4. VENDORS

| Vendor | Where called (file:line) | Data sent | Needed DPA? |
|---|---|---|---|
| Supabase (Postgres + Auth) | `src/lib/supabase.ts:38-46`, `src/lib/auth.ts:3,79`; all `db()` calls | Everything: staff email, name, role, password (Auth), session hashes and user agent, audit log, encrypted vault ciphertext, run logs, Cloudflare data, zone contacts, Slack IDs | Yes. Customer-owned project per the landing page. UNVERIFIED: whose Supabase account is used, and whether a DPA is signed with Supabase. |
| Vercel (hosting) | `vercel.json`, `src/lib/captcha.ts:20` (VERCEL env) | Every request: IPs, headers, cookies. Server logs (console.error output, setup token) | Yes, if you host. UNVERIFIED: Vercel DPA, log retention, region. |
| GitHub (Actions worker + API) | `src/lib/worker-wake.ts:26,72,93,153`, `.github/workflows/worker.yml:34-40` | Dispatch body is `{ref}` only. The worker runs with SUPABASE_SERVICE_ROLE_KEY and REDIS_URL as secrets. Actions logs hold worker stdout. | Yes (sub-processor running code on personal data). UNVERIFIED: GitHub DPA, log retention, private repo. |
| Cloudflare API (api.cloudflare.com) | `src/lib/cf-read.ts:16`, `src/lib/cf-audit.ts:29`, `src/lib/traffic.ts:17`, `src/lib/zone-explorer.ts:12`, `src/lib/restore.ts:1108`, `runner/backup.js:244` | Customer's stored API tokens and Global API Key (at run time). Reads config, audit logs (actor emails and IPs), traffic and visitor IPs | Customer's own account. Data is fetched, not sent. Cover in the customer DPA. |
| Cloudflare Turnstile | `src/components/captcha.tsx:14`, `src/lib/captcha.ts:8,29` | Browser fingerprint/challenge data from login/setup visitors, plus visitor IP (`remoteip`) | Yes, if enabled. UNVERIFIED: Turnstile terms and DPA. List it in the privacy notice. |
| Cloudflare DNS over HTTPS (cloudflare-dns.com) | `src/lib/doh.ts:12` | Hostnames looked up (zone hostnames) | Low risk. List as a sub-processor. |
| Cloudflare R2 (S3 API) | `src/lib/kinds.ts:67`, `src/lib/bucket-store.ts`, `runner/backup.js:3561` | Backup archives (Terraform/JSON of the customer's Cloudflare config, which may include emails in Access policies or notifications) | Customer's bucket. Cover in the customer DPA. |
| AWS S3 | `src/lib/bucket-store.ts:35,39`, `src/lib/providers.ts:157,229-234`, `runner/backup.js:3536` | Same as R2 | Customer's bucket. Cover in the customer DPA. |
| Slack (incoming webhook + slash command response_url) | `src/lib/notify.ts:30-33,78`, `src/lib/monitor-config.ts:95`, `src/app/api/hooks/slack/route.ts:77` | Finding titles, zone and account names, report text. Command answers can include visitor IPs from Ray lookups. Receives Slack user/team ID and command text. | Customer's workspace. UNVERIFIED: whether the customer or you own the Slack app. |
| Generic webhook (admin-configured URL) | `src/lib/notify.ts:43-48,78` (via `safePost`, `src/lib/safe-url.ts`) | Findings: id, check, severity, title, detail, account, zone | The customer chooses the endpoint. Mention in the DPA as "customer-configured destinations". |
| Redis (optional, REDIS_URL) | `src/lib/cache.ts:3,27,40`, `src/lib/rate-limit.ts:3,115` | Hashed rate-limit keys. Cached API responses, e.g. Cloudflare activity with actor emails and IPs, for 2 min (`src/lib/cf-audit-cache.ts`) | Yes, if a hosted Redis is used. UNVERIFIED: which provider, and its DPA. |
| HashiCorp (checkpoint + releases) | `src/lib/tools.ts:117,170-171` | Server IP / user agent only (tool version check, download) | No personal data. List optionally. |
| GitHub Releases (cf-terraforming) | `src/lib/tools.ts:120,174-175` | Server IP only | No. |
| Google Fonts (via next/font) | `src/app/layout.tsx:2`, `src/app/page.tsx:3` | Fetched at **build** time and self-hosted, so visitors never contact Google | No. |
| npm deps with network use | `@supabase/supabase-js`, `redis` (`package.json:17,22`) | See Supabase / Redis | n/a |

### 5. Placeholders and decisions only the owner or a lawyer can make

1. **Controller vs processor model.** Is each customer running their own copy (customer = controller, you = software vendor or processor), or do you host it for them? This decides whether you need a DPA, a sub-processor list and which privacy notice applies.
2. **Legal entity name, registered address, company number and privacy contact** for the footer and the policies (none exist in the code).
3. **Real sales/contact email** for `NEXT_PUBLIC_SALES_EMAIL`. The current fallback is `sales@example.com` (`src/lib/brand.ts:4`).
4. **Privacy policy text** (landing visitors, sales email contacts, console users, third-party data from Cloudflare).
5. **Terms of Service / MSA** and whether acceptance is click-through at setup or by signed contract. Also the version numbering scheme for acceptance records.
6. **Refund / cancellation terms** (no public pricing today).
7. **Retention periods** for `audit_log`, `approval_states`, `runs`/`run_logs`, `notifications`, `cloudflare_alerts`, monitor findings, and failed-login emails.
8. **Anonymise vs keep on user deletion**: whether keeping actor emails in the audit log is justified (e.g. security/legitimate interest) and for how long.
9. **Signed DPAs and regions**: Supabase, Vercel, GitHub, Redis provider (if used), Cloudflare (Turnstile), Slack (if you operate the app). Also Supabase backup/PITR retention, Vercel log retention and GitHub Actions log retention.
10. **Whether sales or marketing email is sent from any external tool** (CRM/ESP). If so, unsubscribe, List-Unsubscribe and a suppression list are needed there.
11. **Turnstile disclosure**: confirm what Turnstile collects or stores client-side, using Cloudflare's own documentation.

## B2. Accessibility, fair design, claims, IP

Scope: `C:\Users\aayde\Downloads\Whitecap Security Analysis\backup-console` (read-only; no project file modified; .env*, ../.env and data/ not opened; no network calls).
Helper scripts (scratchpad/audit): `contrast.mjs` (output `contrast-table.md`), `iconbtn2.mjs`, `licenses.mjs` (output `licenses-out.txt`), `cand.mjs`.
Date: 2026-11-01. Effort key: S = under 1 hour, M = half a day, L = more than a day.

**Theme note:** the product has **one theme, dark only**. `src/app/globals.css:94` sets `html { color-scheme: dark; }`, and there is no `prefers-color-scheme`, `data-theme` or light token set anywhere in `src/`. So the "light theme" column is NOT RELEVANT: there is no light theme to measure. This is not a WCAG failure, because WCAG does not require a light mode.

---

### 1. Accessibility (WCAG 2.2 AA)

| Item | Status | Evidence | Fix (effort) |
|---|---|---|---|
| Text contrast: ink / ink-2 / muted / faint on all surfaces | DONE | Lowest is `faint` #868a93 on `raised-2` #202025 at **4.69:1**; muted is at least 7.63:1 (contrast table below) | None |
| Status text contrast: `color-bad` (#e3243f) used as text | NEEDS WORK | 4.30:1 on canvas, 4.12 on surface, 3.87 on raised, **3.86 on its own `bg-bad/10` badge**. Used about 73 times in `.tsx`, including `text-xs` field errors at `src/components/ui.tsx:111` and the Failed badge at `ui.tsx:247` | Lighten `--red-400` for text, e.g. `#f0566a`: 5.26 on raised, 5.06 on its /10 tint. Or add a separate `--color-bad-text` token (S) |
| Other status / accent text (signal, ok, warn, info) | DONE | Lowest is warn on raised at 6.78:1; signal-ink on gold-deep at 6.51 | None |
| Input boundary contrast (1.4.11) | NEEDS WORK | `.input` border `--color-line` #24242a on `sunken` #08080a is **1.30:1** (`globals.css:150-153`); `line-strong` (hover) is 1.80. The input fill (sunken) is also almost the same as the surface around it | Give form controls their own border token, e.g. `#686c75` (3.80 on sunken, 3.58 on surface). Card and divider borders are decorative and can stay (S) |
| Focus ring contrast | DONE | `--color-ring` #f3d98e is at least 12.75:1 on every surface; the global `:focus-visible` outline is 2px (`globals.css:110`) | None |
| Landing demo chart bars (non-hot) | NEEDS WORK (minor) | `.lp-bar` is signal 38% mixed with raised-2, giving **2.67:1** on surface (`globals.css:350`). This is the demo traffic chart | Raise the mix to about 50%, or note that it is decorative sample data (S) |
| `lp-band-ink-2` on crimson | NOT RELEVANT | Would be 3.55:1, but the token is never used outside its definition (`globals.css:221`, no other match) | Remove the unused token, or fix the mix to at least 0.9 (4.56) before using it (S) |
| Alt text on images | DONE | The only `<img>` is `src/app/opengraph-image.tsx:21` (`alt=""`, server-rendered OG image). No `next/image` is used. `BrandMark` svg is `aria-hidden` (`src/components/brand-mark.tsx:9`), the hero canvas is `aria-hidden` (`landing/hero-field.tsx:142`), and the header logo link has `aria-label` (`src/app/page.tsx:112`) | None |
| Decorative icons hidden | DONE | lucide-react 1.62 adds `aria-hidden="true"` by default (`node_modules/lucide-react/dist/esm/shared/src/build/buildLucideIconNode.mjs`) | None |
| Accessible names on icon-only controls | NEEDS WORK | 2 found (of 105 `<button>` plus links, scanned with `iconbtn2.mjs`): `src/app/console/(app)/(overview)/page.tsx:195` is a `<Link>` that contains only `<Wrench/>`; `src/app/console/(app)/vault/page.tsx:237` is a show/hide secret `<button>` that contains only `<Eye/>`/`<EyeOff/>`. Both have no accessible name because lucide hides the icon | Add `aria-label="Settings"`, and `aria-label={hidden ? 'Show value' : 'Hide value'}` with `aria-pressed` (S) |
| Native interactive elements / roles and key handling | NEEDS WORK | Clickable `<tr onClick>` rows cannot be reached by keyboard: `src/app/console/(app)/traffic/zone-detail.tsx:305` (rule rows), `:339` (IP rows), `:603` (OWASP rule rows). No tabindex, role or key handler. The other custom widgets are fine: the `role="slider"` handles Arrow, Page, Home and End keys (`landing/diff-slider.tsx:72-96`), the tabs use roving tabindex (`security-audit/[auditId]/page.tsx:102`), and the shell backdrop `div onClick` (`shell.tsx:268`) has Escape through the focus trap | Put a `<button>` inside the first cell of each row (the row click can stay for mouse users) (M) |
| Visible focus: chart bar buttons | NEEDS WORK | `focus:outline-none` with only `bg-raised/60` as a replacement: `src/app/console/(app)/traffic/page.tsx:124`, `traffic/zone-detail.tsx:205`. raised against surface is **1.06:1**, so focus is effectively invisible | Use `focus-visible:ring-2 focus-visible:ring-ring` like `traffic/page.tsx:45` already does (S) |
| Visible focus: tag filter input | NEEDS WORK | `src/components/tag-filter.tsx:81` has `outline-none`, and its wrapper (`:72`) has no `focus-within` style | Add `focus-within:border-signal focus-within:ring-…` to the wrapper (S) |
| Visible focus: audit tab panel | NEEDS WORK (minor) | `security-audit/[auditId]/page.tsx:111` is `tabIndex={0}` plus `focus:outline-none`, so the focus stop shows nothing | Remove `focus:outline-none`, or use focus-visible ring (S) |
| Visible focus: vault .env file picker | NEEDS WORK (minor) | `vault/page.tsx:462` uses an `sr-only` file input inside a `<label>`; the label has no `focus-within` style, so keyboard focus lands on an invisible 1px element | `focus-within:outline` on the label (S) |
| Visible focus: `.input`, modal and menu containers | DONE | `.input:focus` swaps the outline for a gold border plus a 3px glow (9.78:1, `globals.css:161`). The `outline-none` on dialog containers (`ui.tsx:313`, `shell.tsx:269`) applies only to programmatic focus on `tabIndex=-1` | None |
| Dialog focus management | DONE | `src/components/use-focus-trap.ts`: moves focus in (`:37-40`), Tab and Shift+Tab trap (`:49-56`), Escape closes (`:44-48`), focus returns to the opener (`:63`), stacked traps (`:12`). `Modal` has `role="dialog" aria-modal aria-labelledby` and a labelled Close button (`ui.tsx:313-320`). The mobile menu uses the same trap (`shell.tsx:269`). The landing `MobileNav` handles Escape, outside click and focus return (`landing/mobile-nav.tsx:13-21`) | None |
| Skip link: landing | DONE | `src/app/page.tsx:69-74` "Skip to content" goes to `<main id="main">` and is visible on focus | None |
| Skip link: console | NEEDS WORK | `src/components/shell.tsx:280` `<main>` has no id and there is no skip link before the long sidebar nav. The `<main>` landmark partly meets 2.4.1, but keyboard users still tab through the whole nav | Add a skip link and `id="main"` in the shell (S) |
| Motion / auto-play (2.2.2) | DONE | Pause buttons on the rotating headline (`landing/hero-headline.tsx:46-50`) and the console tour (`landing/console-tour.tsx:148`). `prefers-reduced-motion` is honoured (`globals.css:190-197`, `:508-512`) | None |
| Session timeout (2.2.1) | DONE | Idle sign-out is at most 30 min (`src/lib/settings.ts:19`); activity extends it; the countdown is shown under 10 min (`shell.tsx:253-256`) | Optional: announce it with `role="status"` (S) |

### Contrast table (dark theme; light theme: none exists)

Computed by `contrast.mjs` from the hex, rgb()/alpha and color-mix() values in `src/app/globals.css` (no oklch is used). Alpha colours are composited over the stated surface. "glass" = `.panel` background (surface at 72%) over canvas.

| Token (fg) | Surface (bg) | Theme | Kind | Ratio | Min | Result |
|---|---|---|---|---|---|---|
| ink #f4f5f7 | canvas / surface / raised / raised-2 / sunken / terminal / glass | dark | text | 18.02 / 17.28 / 16.23 / 14.87 / 18.34 / 18.68 / 17.50 | 4.5 | PASS |
| ink-2 #d9dce1 | same order | dark | text | 14.30 / 13.71 / 12.88 / 11.80 / 14.56 / 14.82 / 13.89 | 4.5 | PASS |
| muted #aeb2ba | same order | dark | text | 9.24 / 8.87 / 8.33 / 7.63 / 9.41 / 9.58 / 8.98 | 4.5 | PASS |
| faint #868a93 | same order | dark | text | 5.68 / 5.45 / 5.12 / **4.69** / 5.78 / 5.89 / 5.52 | 4.5 | PASS |
| signal (gold) #d9b04c as text | canvas / surface / raised / glass | dark | text | 9.61 / 9.21 / 8.65 / 9.33 | 4.5 | PASS |
| ok #3fbf8a | canvas / surface / raised / glass | dark | text | 8.45 / 8.11 / 7.61 / 8.21 | 4.5 | PASS |
| warn #e8892b | canvas / surface / raised / glass | dark | text | 7.53 / 7.22 / 6.78 / 7.31 (6.32 on warn/10 tint) | 4.5 | PASS |
| **bad #e3243f** | canvas / surface / raised / glass | dark | text | **4.30 / 4.12 / 3.87 / 4.17** | 4.5 | **FAIL** |
| **bad #e3243f** | bad/10 tint over surface (badges) | dark | text | **3.86** | 4.5 | **FAIL** |
| info #b8c2d0 | canvas / surface / raised / glass | dark | text | 10.92 / 10.47 / 9.83 / 10.61 | 4.5 | PASS |
| signal-ink #050506 | signal / gold-deep / signal-soft (gold buttons) | dark | text | 9.96 / 6.51 / 14.67 | 4.5 | PASS |
| ok | morph "done" bg (ok 16% over surface) | dark | text | 6.26 | 4.5 | PASS |
| lp-band-ink #f4f5f7 | crimson-deep #6e0a1a / crimson #c8102e (CTA band) | dark | text | 11.18 / 5.39 | 4.5 | PASS |
| lp-band-ink-2 (unused) | crimson-deep / crimson | dark | text | 7.36 / **3.55** | 4.5 | FAIL (unused) |
| lp-diff-del-ink / lp-diff-add-ink | their tints over terminal | dark | text | 5.77 / 9.36 | 4.5 | PASS |
| faint (placeholder) | sunken (input) | dark | text | 5.78 | 4.5 | PASS |
| ring #f3d98e (focus) | canvas / surface / raised | dark | UI | 14.16 / 13.58 / 12.75 | 3 | PASS |
| signal (focus border, active UI) | canvas / surface / raised / sunken | dark | UI | 9.61 / 9.21 / 8.65 / 9.78 | 3 | PASS |
| **line #24242a** (input border) | sunken / canvas / surface / glass | dark | UI | **1.30 / 1.27 / 1.22 / 1.24** | 3 | **FAIL** (applies to inputs; decorative borders exempt) |
| **line-strong #3a3b42** | sunken / canvas / surface / glass | dark | UI | **1.80 / 1.76 / 1.69 / 1.71** | 3 | **FAIL** (same scope) |
| glass-border rgb(255 255 255/.08) | canvas / surface / sunken / glass | dark | UI | 1.19 / 1.22 / 1.17 / 1.21 | 3 | FAIL (decorative card edge: exempt) |
| lp-bar (non-hot demo bar) | surface | dark | UI | **2.67** | 3 | FAIL (minor) |
| raised (chart-bar "focus" fill) | surface | dark | UI | **1.06** | 3 | FAIL (focus indicator) |

Candidate fixes (computed): bad text `#f0566a` gives 5.26 on raised and 5.06 on its tint. Control border `#686c75` gives 3.80 on sunken and 3.58 on surface; `#6e737c` gives 3.96 on surface and 3.40 on raised-2.

---

### 2. Fair design

The product has no checkout, no prices, no subscriptions and no self-serve sign-up. The landing "Plans" section is a contact-sales mailto only.

| Item | Status | Evidence | Fix (effort) |
|---|---|---|---|
| Pre-ticked add-ons / consents | NOT RELEVANT | No consent, marketing-opt-in or add-on checkboxes; sign-in only. (Product default, not consent: restore plans pre-select deletes, "Not in the backup: offered as a delete, selected", `src/app/page.tsx:429`. This is a UX safety decision, see owner list) | None |
| Confirmshaming | DONE | CTAs are neutral: "Sign in", "Talk to sales", "Talk to us", "Contact sales" (`page.tsx:136-137, 536, 596-597`); no decline copy | None |
| Fake urgency timers | DONE | The only countdown is the real session idle timer (`shell.tsx:253-256`, from `settings.ts:19`); no marketing timers or "limited offer" copy | None |
| Drip pricing | NOT RELEVANT | No prices anywhere; `page.tsx:534` says "Tell us about your setup and we will put one together with you" | None |
| Auto-renewal terms | NOT RELEVANT | No subscription or billing flow in code | Needed in the sales contract, not the app |
| Online cancellation | NOT RELEVANT | No online purchase, so no online cancellation duty | Same |
| Landing pricing / CTA copy | DONE (with placeholder) | Plans copy is factual (`page.tsx:533-547`). The sales address falls back to the placeholder `sales@example.com` (`src/lib/brand.ts:4,16`) and appears as visible text (`page.tsx:537`) | Set `NEXT_PUBLIC_SALES_EMAIL` before launch (S) |

---

### 3. Claims (landing page, brand.ts, README)

No testimonials, reviews, customer logos, "trusted by" lines, SOC 2 / ISO 27001 / HIPAA / "certified" wording, uptime or SLA figures, or AI content. Grep over `src/app/page.tsx`, `src/components/landing/*`, `src/lib/brand.ts` and `README.md` found none. README.md is operational documentation, not marketing.

| Item | Status | Evidence (exact string) | Fix (effort) |
|---|---|---|---|
| Time claim | NEEDS WORK | `src/lib/brand.ts:11` "…restore any of it **in minutes**…" (also used as meta, OG and hero lede, `page.tsx:29-31,129`). Nothing measures this: the worker takes "about 2–3 minutes to come up" (`README.md:158`) before plan, review and apply | Drop "in minutes", or say "restore any zone from its newest backup" (S) |
| Absolute-coverage claim | NEEDS WORK (minor) | `brand.ts:11` "Back up **every** Cloudflare zone and account setting". The backup is 134 Terraform types plus JSON for the rest, with secrets excluded, so "every" is an absolute | "Back up your Cloudflare zones and account settings…" or keep and verify (S) |
| Scale claim | UNVERIFIED | `page.tsx:559` "Will it slow down with thousands of zones?" "**It is built for that.**" The design supports it (`README.md:495` lanes and budgets), but there is no load-test evidence in `tests/` | Test at that scale, or soften to "It is designed for many zones…" (S) |
| Generalisation | DONE (opinion, low risk) | `page.tsx:456` "Most teams keep Cloudflare safe with dashboard clicks and a script someone wrote once." | Optional: "Many teams…" (S) |
| "Only read" vs listed writes | DONE | `page.tsx:349` "All of them only read." is qualified at `:371-372`, which lists every write (restore apply, revert, purge, rollback, Logpush) | None |
| Security claims | DONE (code-backed) | `page.tsx:491` AES-256-GCM + scrypt match `src/lib/vault.ts:77,83`. `:496` "30 minutes at most" matches `src/lib/settings.ts:19`. `:498` HSTS/CSP match `src/proxy.ts:65` (CSP is per request). `:493` "a guard stops any write" matches `src/lib/cf-readonly-proxy.ts:5` | Keep these in sync with code |
| Numbers from code constants (OK) | DONE | `page.tsx:44,53,58,60`: ZONE_READS = ZONE_ENDPOINTS + SETTING_IDS + RULE_PHASES; CHANGE_CATEGORIES = CATEGORIES.length; ROLE_COUNT = ROLES.length; CHECK_COUNT = CHECKS.length (all imported) | None |
| Hardcoded product numbers | DONE (drift risk) | `page.tsx:48-49` `TF_ZONE_TYPES = 57`, `TF_ACCOUNT_TYPES = 77` (shown as 134): recounted from `runner/backup.js:2205` (57) and `:2351` (77), so **correct today**. `page.tsx:56` `DRILL_LEVELS = 4` is a hand constant | Add a unit test that asserts 57/77 against `runner/backup.js` (S) |
| Demo / sample figures | DONE (labelled) | "71% / 27% / 2%" with "Sample month" (`page.tsx:276-280`); "42 resources · .tf + JSON · demo" (`landing/backup-button.tsx:31`, `console-tour.tsx:92`); "Demo · sample data" (`console-tour.tsx:146`); footer "Zones, numbers and notifications in the demos on this page are sample data on example.com and example.net." (`page.tsx:622`) | None |
| Third-party facts | DONE (may age) | `README.md:153` "Public repositories get unlimited Actions minutes; private ones get 2,000 a month." This is GitHub's current policy and may change | Recheck at launch (S) |
| Trademark | DONE | `page.tsx:623` "Cloudflare is a trademark of Cloudflare, Inc." (nominative use, no Cloudflare logo used) | None |
| AI content labelling | NOT RELEVANT | No AI features; the security audit is fixed rules (`page.tsx:324` "fixed rules check…") | None |

---

### 4. Intellectual property

| Item | Status | Evidence | Fix (effort) |
|---|---|---|---|
| Brand images | UNVERIFIED | `public/brand/*.svg` (14 files plus `geometry.json`) and `src/app/icon.svg`, the "Castellan" brand. There is no licence, copyright or provenance file in `public/` or `design-system/` | Owner confirms it is original or commissioned work with an IP assignment, and the "Castellan" name is cleared (trademark search) (S to M) |
| Fonts | DONE | Fira Sans and Fira Code (`src/app/layout.tsx:2,7-8`) and Archivo (`page.tsx:3,25`) via `next/font/google`, self-hosted at build time. All three are SIL Open Font License 1.1, which allows bundling and needs no UI notice (OFL text should go in a notices file) | Include the OFL in the notices file (S) |
| Icons | DONE | lucide-react 1.62.0, ISC (`node_modules/lucide-react/package.json`); ISC asks for the copyright notice in copies | List it in the notices file (S) |
| OG image | DONE | `src/app/opengraph-image.tsx` renders the brand mark with `ImageResponse` (Next, MIT); no stock imagery | None |
| Dependency licences | DONE (see summary) | 382 installed packages: no GPL or AGPL; 2 LGPL (optional, sharp binaries); 3 MPL-2.0 (dev); no unknown licences | See notes below |
| Open-source notices screen / file | NEEDS WORK | No licences, notices or third-party page or file (grep for `licen[cs]e|open.?source|third.?party|notices` in `src/**/*.tsx`: no matches). The client bundle ships MIT, ISC and Apache code (React, Next, lucide, supabase-js, tslib 0BSD) | Generate `THIRD_PARTY_NOTICES.txt` at build time (for example `license-checker --production`) and serve or link it from the footer (S to M) |
| DMCA / takedown policy | NOT RELEVANT (decision noted) | Uploads are private operator inputs, not public user content: a BIND zone file (`onboarding/page.tsx:93`) is sent as text to `api/onboarding/compare/route.ts:9-16` and compared, at most 512 KB; a tags CSV (`zones/tags/page.tsx:252`) and a `.env` import (`vault/page.tsx:462`) go to the owner's own Supabase. The console is behind sign-in and `robots.ts:9` disallows `/console` and `/api`. Nothing is published to other users or the public | No DMCA agent or policy needed for launch. Revisit only if shared or public content is added (S) |

### Licence summary (installed `node_modules`, 382 packages, from `licenses.mjs`)

| Licence | Count |
|---|---|
| MIT | 317 |
| Apache-2.0 | 26 |
| ISC | 20 |
| BSD-2-Clause | 7 |
| MPL-2.0 | 3 |
| BSD-3-Clause | 2 |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | 1 |
| Apache-2.0 AND LGPL-3.0-or-later | 1 |
| Python-2.0 (argparse, dev) | 1 |
| CC-BY-4.0 (caniuse-lite, build-time via Next/browserslist, attribution needed) | 1 |
| BlueOak-1.0.0 (minimatch, dev) | 1 |
| CC0-1.0 (language-subtag-registry, dev) | 1 |
| 0BSD (tslib, runtime) | 1 |
| UNKNOWN / UNLICENSED | 0 |
| GPL / AGPL / EPL | 0 |

**Every copyleft or weak-copyleft package:**

| Package | Licence | Runtime or dev | Note |
|---|---|---|---|
| @img/sharp-win32-x64@0.35.5 (installed) | Apache-2.0 AND LGPL-3.0-or-later | runtime, optional (Next → sharp) | Bundles prebuilt libvips (LGPL) |
| @img/sharp-wasm32@0.35.5 (installed) | Apache-2.0 AND LGPL-3.0-or-later AND MIT | runtime, optional | Same |
| @img/sharp-libvips-linux-x64@1.3.4 (lockfile only; installed on Linux, Docker and Vercel) | LGPL-3.0-or-later | runtime, optional | Pulled on the Linux deploy. The lockfile also lists the libvips builds for darwin-arm64/x64, linux-arm/arm64/ppc64/riscv64/s390x and linuxmusl-arm64/x64, plus sharp-win32-arm64/ia32: 14 LGPL entries in all, one per platform |
| axe-core@4.14.0 | MPL-2.0 | dev (eslint-config-next / jsx-a11y) | Not shipped |
| lightningcss@1.32.0 | MPL-2.0 | dev (Tailwind v4 build) | Build tool, output not covered |
| lightningcss-win32-x64-msvc@1.32.0 | MPL-2.0 | dev | Plus 12 other platform builds in the lockfile, all dev |

LGPL note: the app uses no `next/image` and no sharp import (grep in `src/` finds nothing); `opengraph-image.tsx` uses `ImageResponse`, not sharp. libvips is a separate, unmodified, dynamically loaded binary, so LGPL obligations are only "give notice and the licence text, and allow replacement". Include the LGPL-3.0 text in the notices file. Alternatively, remove sharp from the Docker image (`npm i --omit=optional` would also drop other optional binaries, so test it).

---

### 5. Placeholders and decisions for the owner

1. **Sales email:** set `NEXT_PUBLIC_SALES_EMAIL`. It currently falls back to `sales@example.com` (`src/lib/brand.ts:4`), which is visible on the landing page (`page.tsx:537`).
2. **"Restore … in minutes"** (`brand.ts:11`): keep it with evidence (a timed restore) or remove it.
3. **"It is built for that"** (thousands of zones, `page.tsx:559`): run a load test or soften the wording.
4. **Brand assets and name:** confirm who made the Castellan logos (`public/brand/`) and that you own them; run a trademark clearance on "Castellan".
5. **Notices file:** decide where third-party notices live (footer link to `/licenses` or a static `THIRD_PARTY_NOTICES.txt`). It must cover MIT/ISC/Apache/BSD, the OFL fonts, CC-BY-4.0 caniuse-lite and the LGPL libvips (if sharp is in the deployed image).
6. **Keep or drop sharp** in the Docker and Vercel deploy (it is unused by the code).
7. **Legal pages:** the footer (`page.tsx:615-619`) has no Privacy or Terms links. This is outside this audit's scope, but it is usually expected on a public marketing page.
8. **Status red:** pick a lighter text red (for example `#f0566a`) or add a separate text token; the brand crimson can stay for fills.
9. **Form-control border token:** pick a value of at least 3:1 (for example `#686c75`) without changing decorative card borders.
10. **Restore default** "Not in the backup: offered as a delete, selected" (`page.tsx:429`): confirm that pre-selecting deletes is the intended safe default. This is a product and UX decision, not a fair-design issue.
11. **Hardcoded 57/77:** add a test so landing numbers fail CI when `runner/backup.js` changes.
