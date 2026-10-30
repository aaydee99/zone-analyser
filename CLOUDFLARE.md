# Putting the console behind Cloudflare: `console.ak-cflabs.com`

How to serve the console at `console.ak-cflabs.com`, a subdomain of the `ak-cflabs.com` zone, through
Cloudflare and in front of Vercel.

```
browser ──► Cloudflare zone ak-cflabs.com (WAF, rate limit, TLS) ──► Vercel (console, CONSOLE_ROLE=web)
                                                                        │
                                       Supabase ◄───────────────────────┤  (direct, not through the zone)
                                       GitHub Actions worker ◄──────────┘  (direct, not through the zone)
```

Only browser traffic goes through the zone. Supabase, GitHub and the worker never do.

**`ak-cflabs.com` may serve other sites, so nothing here changes the zone as a whole.**

- Every rule below is limited to the console with `http.host eq "console.ak-cflabs.com"`.
- Zone settings the console needs differently are overridden for this hostname only, with one
  **Configuration Rule** (§8). Your other hostnames keep their current settings.
- The few settings that can only be zone-wide are marked **zone-wide** below, with what the console
  needs from them.

Settings marked **Pro+** need the Pro plan or above. Everything else works on Free.

**On Enterprise, do §1–§10 first, then apply §11.** §11 replaces a few earlier steps (timeout, rate
limiting) and adds rules only Enterprise has.

---

## 0. Order of work

Follow this order. If you set the secret in Vercel before Cloudflare sends it, every request gets a 403.

1. Add the domain in Vercel, then create the DNS record (§1).
2. Create the Turnstile widget (§3).
3. Create the origin secret and the Transform Rule that sends it (§4).
4. Add the Vercel environment variables and redeploy (§5).
5. Add the cache rules (§6), security rules (§7) and the Configuration Rule (§8).
6. Check the zone-wide settings (§2, §9).
7. Run the checks in §10.

---

## 1. DNS

1. In **Vercel → Project → Settings → Domains**, add `console.ak-cflabs.com`.
   - If Vercel asks you to verify the domain (it does when `ak-cflabs.com` is already used by
     another Vercel account or project), add the `TXT` record it shows (`_vercel` …) in Cloudflare
     DNS first.
2. In **Cloudflare → ak-cflabs.com → DNS → Records**:

| Type  | Name      | Target                     | Proxy status      | TTL  |
|-------|-----------|----------------------------|-------------------|------|
| CNAME | `console` | `zone-analyser.vercel.app` | Proxied (orange)  | Auto |

(`cname.vercel-dns.com` works just as well; both lead to Vercel's edge.)

**Step 1 is still required.** Vercel picks the project by the `Host` header, not by the CNAME
target. If `console.ak-cflabs.com` isn't added in Vercel → Domains, Vercel answers
`404 DEPLOYMENT_NOT_FOUND`.

> **Don't add an Origin Rule that overrides the Host header** to `zone-analyser.vercel.app`. The
> console requires a write request's `Origin` (`https://console.ak-cflabs.com`) to match its `Host`.
> With the Host rewritten, every sign-in, backup and save fails with **403 "Cross-origin request
> refused"**, and HTTP→HTTPS redirects send people to the `vercel.app` address. Leave Host
> unchanged; `CONSOLE_ALLOWED_HOSTS=console.ak-cflabs.com` then keeps the `vercel.app` address
> closed to direct visits.

Cloudflare's Universal SSL certificate covers `ak-cflabs.com` and `*.ak-cflabs.com`, so
`console.ak-cflabs.com` is covered with no extra certificate. (A deeper name such as
`a.console.ak-cflabs.com` would not be.)

Vercel renews its own certificate for the domain over HTTP at `/.well-known/acme-challenge/`. That
path must never be blocked, challenged or cached. The skip rule in §7.1 covers it.

---

## 2. SSL/TLS

The console's encryption mode is set per hostname by the Configuration Rule (§8), so the zone's own
mode can stay as it is for your other sites.

| Setting | Scope | What the console needs |
|---|---|---|
| SSL/TLS encryption mode | **Console only** (§8) | **Full (strict)**. Vercel has a valid certificate. *Flexible* causes a redirect loop, because the console redirects HTTP to HTTPS itself. |
| Automatic HTTPS Rewrites | Console only (§8) | On |
| Opportunistic Encryption | Console only (§8) | On |
| Always Use HTTPS | zone-wide | On is best. If it's off for the zone, the console redirects HTTP to HTTPS on its own. |
| Minimum TLS Version | zone-wide | 1.2 or higher, if your other sites allow it |
| TLS 1.3 | zone-wide | On |
| 0-RTT Connection Resumption | zone-wide | Off is safer (early data can be replayed). Leave it if other sites need it; the console only accepts state-changing requests with a session and a matching Origin. |
| HSTS (Edge Certificates) | zone-wide | **Leave the zone's choice.** The console sends its own `Strict-Transport-Security: max-age=63072000; includeSubDomains`. That `includeSubDomains` covers only `*.console.ak-cflabs.com`, never `ak-cflabs.com` or your other subdomains. |
| Authenticated Origin Pulls | zone-wide | Not needed. Vercel doesn't check client certificates; the origin secret (§4) does this job. |

---

## 3. Turnstile (CAPTCHA on sign-in and first-run setup)

1. **Cloudflare dashboard → Turnstile → Add widget**.
2. Hostname: `console.ak-cflabs.com`. Mode: **Managed**.
3. Copy the **site key** and **secret key** into Vercel (§5).

The console turns CAPTCHA on when both keys are set. It also allows `https://challenges.cloudflare.com`
in its Content-Security-Policy by itself, with no rebuild needed.

---

## 4. Origin secret: only Cloudflare may reach Vercel

Without this, anyone can reach Vercel directly by sending `Host: console.ak-cflabs.com` to Vercel's
IPs. That skips the WAF and the rate limit, and lets them fake `cf-connecting-ip`.

With `CONSOLE_ORIGIN_SECRET` set, the console answers **403 "Direct access is not allowed"** to any
request that doesn't carry the secret header. Cloudflare adds the header to every request it forwards
to the console.

### 4.1 Create the secret

Make a long random value, and keep it out of Git and chat:

```sh
openssl rand -hex 32
```

### 4.2 Transform Rule

**ak-cflabs.com → Rules → Transform Rules → Modify Request Header → Create rule**

| Field | Value |
|---|---|
| Rule name | `Console origin secret` |
| If incoming requests match | Custom filter expression |
| Expression | `(http.host eq "console.ak-cflabs.com")` |
| Then | **Set static** |
| Header name | `x-console-origin-auth` |
| Value | *the secret from 4.1* |

Deploy it **before** setting the secret in Vercel. Because the expression names the console's host,
your other sites never receive the header.

Notes:
- Anyone with edit access to the zone's rules can read the value. Limit who has that access.
- To change the header name, set `CONSOLE_ORIGIN_HEADER` in Vercel to the same name, in lowercase.
- **Rotating the secret:** change the Transform Rule value, then the Vercel variable, then redeploy.
  Requests fail with 403 for the minute or two between the two steps, so do it at a quiet time.
- Vercel preview URLs (`*.vercel.app`) also get the 403 once the secret is set, because Cloudflare
  isn't in front of them. Leave the variable out of the **Preview** environment if you use previews.
- Loopback requests (`127.0.0.1`, `localhost`) skip the check everywhere except on Vercel, so the
  worker and local development keep working.

---

## 5. Vercel environment variables

**Vercel → Project → Settings → Environment Variables (Production)**, then **redeploy**.

| Variable | Value | Why |
|---|---|---|
| `CONSOLE_ALLOWED_HOSTS` | `console.ak-cflabs.com` | Any other `Host` gets 403 "Host not allowed". |
| `CONSOLE_ORIGIN_SECRET` | *the secret from 4.1* | Refuses requests that didn't come through Cloudflare (§4). |
| `CONSOLE_ORIGIN_HEADER` | *(leave unset)* | Only if you renamed the header in §4.2. |
| `CONSOLE_CLIENT_IP_HEADER` | `cf-connecting-ip` | Rate limits use the visitor's real IP instead of a Cloudflare edge IP. Safe only because of §4. |
| `CONSOLE_RELAY_TIMEOUT_MS` | `90000` | Cloudflare ends a request after **100 s** (error 524). The console waits up to 280 s for the worker by default. At 90 s, a slow call gets the console's own clear error instead of a Cloudflare error page. |
| `TURNSTILE_SITE_KEY` | *from §3* | |
| `TURNSTILE_SECRET_KEY` | *from §3* | |

Leave everything else (Supabase, `WORKER_GITHUB_*`, `VAULT_SERVER_KEY` and so on) as it is.

---

## 6. Cache Rules

**ak-cflabs.com → Caching → Cache Rules.** The console sends `Cache-Control: no-store` on every page
and API response. The only exception is Next.js's content-hashed build files under `/_next/static/`,
which Next.js serves as `public, max-age=31536000, immutable`.

Create these two rules **in this order**. Both include the host, so caching for your other sites
doesn't change.

**Rule 1: Console build assets**

```
(http.host eq "console.ak-cflabs.com" and starts_with(http.request.uri.path, "/_next/static/"))
```

- Cache eligibility: **Eligible for cache**
- Edge TTL: **Use cache-control header if present**
- Browser TTL: **Respect origin TTL**

**Rule 2: Never cache anything else on the console**

```
(http.host eq "console.ak-cflabs.com" and not starts_with(http.request.uri.path, "/_next/static/"))
```

- Cache eligibility: **Bypass cache**

Rule 2 is a backstop. Cloudflare caches some file extensions by default, `.csv` among them.
Responses such as `/api/zone-explorer/<id>/export.csv`, `/api/zone-explorer/<id>/dns.csv`,
`/api/cloudflare-audit/export.csv` and `/api/runs/<id>/download` hold zone configuration, so they
must never be stored at the edge.

> **Always keep `http.host eq "console.ak-cflabs.com"` in Rule 2.** Without it, the rule turns off
> caching for every site in the zone.

These caching settings are **zone-wide** and need no change for the console. Its rules above take
priority on its hostname:

| Setting | Note |
|---|---|
| Caching Level, Browser Cache TTL | Any value; the cache rules above decide for the console. |
| Always Online | Off is best. It only serves stale copies of cacheable pages, and the console has none outside `/_next/static/`. |
| Crawler Hints, Tiered Cache | Either way. |

---

## 7. Security Rules

### 7.1 WAF custom rules

**ak-cflabs.com → Security → WAF → Custom rules.** Each rule names the console's host, so your other
sites aren't affected. Put them **in this order**, above any existing zone rules that could block
the console.

**1. Skip for Vercel certificate renewal**

```
(http.host eq "console.ak-cflabs.com" and starts_with(http.request.uri.path, "/.well-known/acme-challenge/"))
```

Action: **Skip** all remaining custom rules, rate limiting rules and managed rules (Pro+). Turn
logging on.

**2. Only your people** (strongly recommended)

The console holds Cloudflare API tokens and can change live zones, so it shouldn't be open to the
whole internet.

```
(http.host eq "console.ak-cflabs.com" and not ip.src in {203.0.113.10 198.51.100.0/24})
```

Action: **Block**. Use your office or VPN addresses, or an IP List (`$console_allow`, under
**Manage Account → Configurations → Lists**) so you can edit them in one place.

If people's IPs change, skip this rule and put **Cloudflare Access** in front instead (§7.4).

**3. Methods the console doesn't use**

```
(http.host eq "console.ak-cflabs.com" and not http.request.method in {"GET" "HEAD" "POST" "PUT" "PATCH" "DELETE"})
```

Action: **Block**. The console already refuses `OPTIONS` on `/api/*`, because it allows no
cross-origin requests.

**4. Countries (optional)**

```
(http.host eq "console.ak-cflabs.com" and not ip.src.country in {"US" "PK"})
```

Action: **Block**. Use the countries your team actually works from.

The Free plan allows 5 custom rules **for the whole zone**. If other sites already use some, combine
rules 2–4 into one Block rule:

```
(http.host eq "console.ak-cflabs.com" and (not ip.src in {203.0.113.10 198.51.100.0/24} or not http.request.method in {"GET" "HEAD" "POST" "PUT" "PATCH" "DELETE"}))
```

> **Don't** put a *Managed Challenge* or *JS Challenge* on the console's `/api/*` or on its whole
> host. The UI calls the API with `fetch`, and `fetch` can't solve a challenge, so the page just
> breaks. Turnstile (§3) already guards sign-in. If an existing zone rule challenges all traffic,
> exclude the console with `and http.host ne "console.ak-cflabs.com"`.

### 7.2 Rate limiting rule

**ak-cflabs.com → Security → WAF → Rate limiting rules.** Free allows one rate limiting rule for the
whole zone. If another site already uses it, add the console's paths to that rule's expression with
`or`, or upgrade.

| Field | Value |
|---|---|
| Rule name | `Console sign-in and setup` |
| Expression | `(http.host eq "console.ak-cflabs.com" and http.request.method eq "POST" and http.request.uri.path in {"/api/auth/login" "/api/setup"})` |
| Counting characteristic | IP |
| Requests / period | **5 per 10 seconds** |
| Action | **Block** |
| Duration | 10 seconds |

The console has its own limits as well: 30 requests a minute per IP on routes that need no session,
600 a minute (60 of them writes) per signed-in user, and a lockout after repeated failed sign-ins.
This rule stops bursts at the edge before they cost Vercel invocations.

### 7.3 Managed rules and bots

| Setting | Scope | What the console needs |
|---|---|---|
| Cloudflare Free Managed Ruleset | zone-wide | On |
| Cloudflare Managed Ruleset (Pro+) | zone-wide | On |
| OWASP Core Ruleset (Pro+) | zone-wide | Fine on. Credential imports (`/api/credentials*`) and restore plans (`/api/restore*`) send JSON that can trip it. If they do, add an exception: `(http.host eq "console.ak-cflabs.com" and (starts_with(http.request.uri.path, "/api/credentials") or starts_with(http.request.uri.path, "/api/restore")))`, skipping the OWASP ruleset. |
| Security Level | Console only (§8) | Medium |
| Browser Integrity Check | Console only (§8) | On |
| Bot Fight Mode (Free) | **zone-wide** | Off is best. It can challenge the console's background API calls, and the Free plan can't exclude one hostname. If your other sites need it on, test the console carefully: sign in, open a live run, start a backup. |
| Super Bot Fight Mode (Pro+) | zone-wide | Definitely automated: Block; Verified bots: Allow or Block (your other sites decide); Static resource protection: Off; JavaScript detections: either way (its script loads from `/cdn-cgi/challenge-platform/` on the same origin, which the CSP allows). |
| Hotlink Protection | Console only (§8) | Off |
| Leaked credentials detection | zone-wide | On, if your plan has it |

### 7.4 Cloudflare Access (optional, free for up to 50 users)

Use this instead of the IP rule (7.1 #2) when your team doesn't have fixed IPs.

**Zero Trust → Access → Applications → Add → Self-hosted**

- Application domain: `console.ak-cflabs.com` (this hostname only, not `*.ak-cflabs.com`)
- Policy: **Allow**, with Emails or email domain set to your team
- Session duration: 8–24 hours
- A second application for `console.ak-cflabs.com/.well-known/acme-challenge/*` with a
  **Bypass** policy, so Vercel can renew its certificate

Access runs in front of the console's own sign-in. Its cookie is sent with the console's `fetch`
calls and with the live run log (SSE), so both keep working.

---

## 8. Configuration Rule: console-only overrides

**ak-cflabs.com → Rules → Configuration Rules → Create rule**

- Rule name: `Console settings`
- Expression: `(http.host eq "console.ak-cflabs.com")`

Then set:

| Setting | Value | Why |
|---|---|---|
| SSL | **Full (strict)** | See §2. |
| Automatic HTTPS Rewrites | On | |
| Opportunistic Encryption | On | |
| Security Level | Medium | |
| Browser Integrity Check | On | |
| Hotlink Protection | Off | |
| **Rocket Loader** | **Off** | Rewrites scripts; the console's CSP blocks the result. |
| **Email Obfuscation** | **Off** | Rewrites the page HTML, and there's nothing to protect on a signed-in console. |
| **Disable Real User Monitoring (RUM)** | **On** | Web Analytics would inject `static.cloudflareinsights.com`, which the CSP blocks. |
| **Disable Zaraz** | **On** | Injects scripts. |
| **Disable Apps** | **On** | Injects scripts. |
| Mirage (Pro+) | Off | |
| Polish (Pro+) | Off | Nothing to optimise; the console has almost no images. |
| Fonts | Off | Fonts are self-hosted. |
| Server Side Excludes | Off | |

These settings inject scripts into pages or rewrite HTML. The console's Content-Security-Policy
(`script-src 'self'`, `connect-src 'self'`) blocks whatever they inject, which breaks pages or fills
the browser console with errors. The rule keeps them off for the console only.

These can't go in a Configuration Rule and are **zone-wide**:

| Setting | What the console needs |
|---|---|
| Speed Brain | Off is best (it prefetches pages). If other sites need it, the console still works; it's just extra requests. |
| Automatic Signed Exchanges | Off |
| Managed Transform "Add security headers" | Off is best. If it's on for other sites, the console gets a second `X-Frame-Options` and `Referrer-Policy`. Browsers use the stricter one, so nothing breaks. |
| Managed Transform "Remove X-Powered-By" | Either way |

Fine to have on: **Brotli**, **Early Hints**, **HTTP/2**, **HTTP/3 (QUIC)**,
**HTTP/2 to origin**.

---

## 9. Network (all zone-wide)

These are zone settings. The console works with the usual defaults.

| Setting | What the console needs | Notes |
|---|---|---|
| HTTP/2, HTTP/3 | On | |
| WebSockets | Either way | Not used. The live run log is Server-Sent Events on `/api/runs/<id>/stream`, with a ping every 15 s, so it stays under Cloudflare's 100 s idle limit. |
| gRPC | Either way | Not used |
| IPv6 Compatibility | On | |
| Pseudo IPv4 | Off | |
| IP Geolocation | On | Needed by the country rule (7.1 #4). |
| Maximum Upload Size | Default (100 MB) | The console refuses request bodies over 1 MB itself. |
| Response Buffering (Enterprise) | Off | Would hold back the SSE log stream. |
| Proxy Read Timeout (Enterprise) | Default 100 s | Matches `CONSOLE_RELAY_TIMEOUT_MS=90000`. |

**Page Rules:** none needed. They're deprecated; everything above uses the newer rule types. If the
zone has an old Page Rule matching `*ak-cflabs.com/*` (cache everything, forwarding and so on), make
sure it doesn't match `console.ak-cflabs.com`.

---

## 10. Checks after setup

Run these from a machine that isn't on the IP allowlist, unless the check says otherwise.

| Check | Expected |
|---|---|
| `curl -sI https://console.ak-cflabs.com/login` (from an allowed IP) | `200`, with `content-security-policy`, `strict-transport-security`, `cache-control: no-store` and `cf-cache-status: DYNAMIC` |
| `curl -sI https://console.ak-cflabs.com/_next/static/<any file from the page>` | `cf-cache-status: HIT` on the second request |
| `curl -sI http://console.ak-cflabs.com/login` | `301` or `308` to `https://` |
| `curl -s https://zone-analyser.vercel.app/login` | `403` "Host not allowed" or "Direct access is not allowed" |
| `curl -s --resolve console.ak-cflabs.com:443:76.76.21.21 https://console.ak-cflabs.com/login` (straight to Vercel, skipping Cloudflare) | `403` "Direct access is not allowed" |
| From a non-allowed IP | Cloudflare block page |
| 6 quick failed sign-ins | Cloudflare `429` / block from the rate limiting rule |
| Sign in, open a running backup | Live log updates, no CSP errors in the browser console |
| Back up while the worker is off | "Starting worker" progress shows; no Cloudflare 524 page |
| `curl -sI https://ak-cflabs.com/` and your other subdomains | Same headers and `cf-cache-status` as before the change: nothing else in the zone moved |

If something fails, check **Security → Events** in Cloudflare (filter by host
`console.ak-cflabs.com` to see which rule fired) and the Vercel function logs (403 reasons from the
console).

---

## 11. Enterprise plan

Everything in §1–§10 still applies. This section changes a few of those steps and adds rules only
Enterprise has. As before, every rule names `http.host eq "console.ak-cflabs.com"`, so the rest of
the zone is untouched.

Some items need add-ons on top of the Enterprise plan: **Bot Management**, **Advanced Rate
Limiting**, **API Shield**, **Page Shield**, **Sensitive Data Detection**. Skip any your contract
doesn't include.

### 11.1 What changes from the steps above

| Step | Free/Pro | Enterprise |
|---|---|---|
| §5 `CONSOLE_RELAY_TIMEOUT_MS` | `90000` (Cloudflare cuts at 100 s) | **Remove it** (default 280 s), and raise the timeout for the console to 300 s (§11.2) |
| §7.1 WAF custom rules | 5 rules for the zone | Many more; keep the console's rules separate. Add the attack-score and bot rules (§11.3) |
| §7.2 Rate limiting | 1 rule, 10 s period, per IP | Several rules, counting by session cookie and by email in the body (§11.4) |
| §7.3 Bot Fight Mode | Zone-wide, no exceptions | Bot Management with per-rule bot scores (§11.3) |
| §9 Response buffering, proxy read timeout | Not available | Buffering off; timeout 300 s for the console (§11.2) |

### 11.2 Timeout for the console: Cache Rule setting

Edit **Rule 2** from §6 (the console's *Bypass cache* rule). Under **Proxy read timeout**, set
**300 seconds**.

- This matches Vercel's 300 s function limit (`vercel.json`) and the console's 280 s worker wait,
  so a slow call (for example while the worker is starting) finishes instead of failing with 524.
- Then **delete `CONSOLE_RELAY_TIMEOUT_MS`** from Vercel and redeploy.
- The live log stream (`/api/runs/<id>/stream`) isn't affected; it sends a ping every 15 s.

Also, under **Network**, turn **Response Buffering Off** for the zone, or leave it off if it
already is. Buffering would hold back the live run log.

### 11.3 WAF custom rules (Enterprise additions)

Put these after the §7.1 rules.

**5. WAF attack score** (block likely SQLi/XSS/RCE payloads aimed at the console)

```
(http.host eq "console.ak-cflabs.com" and cf.waf.score lt 20)
```

Action: **Log for a week, then Block.** Credential imports (`/api/credentials/import`) and restore
plans carry large JSON that can score low. If Security Events shows false positives there, add
`and not starts_with(http.request.uri.path, "/api/credentials") and not starts_with(http.request.uri.path, "/api/restore")`.

**6. Bot Management: automated traffic** (needs Bot Management)

```
(http.host eq "console.ak-cflabs.com" and cf.bot_management.score eq 1 and not cf.bot_management.verified_bot)
```

Action: **Block**. Score 1 means definitely automated. Real browsers using the console never score 1.

**7. Bot Management: likely bots on sign-in and setup**

```
(http.host eq "console.ak-cflabs.com" and http.request.method eq "POST" and http.request.uri.path in {"/api/auth/login" "/api/setup" "/api/vault/unlock"} and cf.bot_management.score lt 30)
```

Action: **Block**. Use Block, not Managed Challenge: these are `fetch` calls, which can't solve a
challenge. Turnstile already handles the people in the grey zone.

**8. Unexpected request bodies**

The console only accepts JSON bodies of 1 MB or less.

```
(http.host eq "console.ak-cflabs.com" and http.request.method in {"POST" "PUT" "PATCH" "DELETE"} and starts_with(http.request.uri.path, "/api/") and http.request.body.size gt 0 and not any(http.request.headers["content-type"][*] contains "application/json"))
```

Action: **Block**.

> Bot Management **JavaScript detections** are fine on the console: the script loads from
> `/cdn-cgi/challenge-platform/` on the same origin, which the CSP allows. Keep them on so bot
> scores are accurate.

### 11.4 Advanced rate limiting

**Security → WAF → Rate limiting rules.** These replace the single rule in §7.2. The console's
session cookie is `cfbc_session`.

| # | Name | Expression (all start with `http.host eq "console.ak-cflabs.com" and …`) | Counting by | Rate | Action / duration |
|---|---|---|---|---|---|
| 1 | Sign-in per IP | `http.request.method eq "POST" and http.request.uri.path in {"/api/auth/login" "/api/setup"}` | IP | 10 / 1 min | Block 10 min |
| 2 | Sign-in per email | `http.request.method eq "POST" and http.request.uri.path eq "/api/auth/login"` | JSON field `email` in the body (`lookup_json_string(http.request.body.raw, "email")`) | 5 / 1 min | Block 15 min |
| 3 | Vault unlock per session | `http.request.method eq "POST" and http.request.uri.path eq "/api/vault/unlock"` | Cookie `cfbc_session` | 5 / 1 min | Block 10 min |
| 4 | Password changes per session | `http.request.method eq "POST" and http.request.uri.path in {"/api/auth/password" "/api/vault/password"}` | Cookie `cfbc_session` | 5 / 10 min | Block 30 min |
| 5 | Credential reveal per session | `starts_with(http.request.uri.path, "/api/credentials/") and ends_with(http.request.uri.path, "/reveal")` | Cookie `cfbc_session` | 10 / 10 min | Block 30 min |
| 6 | API writes per session | `starts_with(http.request.uri.path, "/api/") and http.request.method in {"POST" "PUT" "PATCH" "DELETE"}` | Cookie `cfbc_session` | 60 / 1 min | Block 1 min |
| 7 | API reads per session | `starts_with(http.request.uri.path, "/api/") and not ends_with(http.request.uri.path, "/stream")` | Cookie `cfbc_session` | 600 / 1 min | Block 1 min |
| 8 | Whole host per IP | *(host only)* | IP | 1200 / 1 min | Block 5 min |

Notes:
- Rules 6 and 7 mirror the console's own per-user limits (60 writes, 600 requests a minute), so
  bursts stop at the edge instead of costing Vercel invocations.
- Rule 7 leaves out `/stream`, so long-lived live logs never count against people.
- Rule 2 reads the JSON body. Turn on **body inspection** if your account needs it switched on.
- For rules counting by cookie, add `and http.request.cookies["cfbc_session"][0] ne ""` so requests
  without a session fall through to rule 1 / 8 instead of sharing one empty counter.
- Run new rules with action **Log** for a few days and check Security Analytics before switching
  to Block.

### 11.5 Leaked credentials detection

**Security → Settings → Leaked credentials detection: On.** The console sends JSON, so add custom
detection locations for its sign-in and password routes:

| Path | Username expression | Password expression |
|---|---|---|
| `/api/auth/login` | `lookup_json_string(http.request.body.raw, "email")` | `lookup_json_string(http.request.body.raw, "password")` |
| `/api/setup` | `lookup_json_string(http.request.body.raw, "email")` | `lookup_json_string(http.request.body.raw, "password")` |
| `/api/auth/password` | *(none)* | `lookup_json_string(http.request.body.raw, "next")` |

Then add WAF custom rules:

**9. Block known-leaked new passwords**

```
(http.host eq "console.ak-cflabs.com" and http.request.uri.path in {"/api/setup" "/api/auth/password"} and cf.waf.credential_check.password_leaked)
```

Action: **Block**, with a custom JSON response: `{"error":"That password appears in known data breaches — choose another"}`, content type `application/json`, status 400. The console's UI shows the `error` field.

**10. Leaked credentials on sign-in**

```
(http.host eq "console.ak-cflabs.com" and http.request.uri.path eq "/api/auth/login" and cf.waf.credential_check.username_and_password_leaked)
```

Action: **Log** (and alert on it, §11.8). Blocking would lock out a real user whose password is
leaked. Have them change it instead.

### 11.6 Managed rules

| Ruleset | Setting |
|---|---|
| Cloudflare Managed Ruleset | On, default actions |
| Cloudflare OWASP Core Ruleset | On. Paranoia level **PL2**, score threshold **Medium (40)**, action **Block**, after a week in Log. Exceptions for the console only, if needed: `(http.host eq "console.ak-cflabs.com" and (starts_with(http.request.uri.path, "/api/credentials") or starts_with(http.request.uri.path, "/api/restore")))` |
| Sensitive Data Detection (add-on) | On, action **Log**. It scans responses. `/api/credentials/<id>/reveal` and the zone exports return secrets and configuration on purpose, so don't block. Use it to see if they're ever served unexpectedly. |
| HTTP DDoS attack protection | Default. Don't lower the sensitivity for the console. |

#### OWASP exceptions for the console

Cloudflare exceptions work per path and per rule, not per JSON field. The exceptions below come from
what each console endpoint actually receives. Run OWASP in **Log** for a week, compare these with
your Security Events, and add only the ones that really fire.

The OWASP ruleset adds up a score: each rule adds points, and the final rule (*949110: Inbound
Anomaly Score Exceeded*) blocks. Skipping a rule removes its points. Rules are named by their CRS
number (for example `942430`). Search the OWASP ruleset's rule list in the dashboard for that
number to find Cloudflare's rule ID.

**A. Skip the whole OWASP ruleset where the body is a secret**

Passwords, API tokens and access keys are random strings that can contain `'`, `"`, `;`, `--`,
`<`, `$(`, `../` and so on. Every OWASP family (SQLi, XSS, RCE, LFI) can fire on them. These
endpoints already have Turnstile or a session, the rate limits in §11.4 and leaked-credentials
detection. None of them builds SQL or shell commands from the input; the console uses parameterised
Supabase queries.

```
(http.host eq "console.ak-cflabs.com" and http.request.method in {"POST" "PUT" "PATCH"} and (
  http.request.uri.path in {"/api/auth/login" "/api/setup" "/api/auth/password" "/api/users" "/api/credentials" "/api/credentials/import"}
  or starts_with(http.request.uri.path, "/api/vault/")
  or starts_with(http.request.uri.path, "/api/users/")
  or (starts_with(http.request.uri.path, "/api/credentials/") and not ends_with(http.request.uri.path, "/reveal"))
  or (starts_with(http.request.uri.path, "/api/restore/") and ends_with(http.request.uri.path, "/apply"))
))
```

→ **Skip: Cloudflare OWASP Core Ruleset.** Keep the Cloudflare Managed Ruleset, the attack score,
leaked credentials and rate limiting on.

| Endpoint | What's in the body |
|---|---|
| `/api/auth/login`, `/api/setup` | email, password |
| `/api/auth/password`, `/api/vault/password` | current and new password |
| `/api/vault/init`, `/api/vault/unlock` | vault password |
| `/api/users`, `/api/users/<id>` | new user's password |
| `/api/credentials`, `/api/credentials/<id>` | Cloudflare token or key, R2/S3 access keys, endpoint URLs |
| `/api/credentials/import` | pasted `.env`-style text: `KEY=value` lines, maybe `export …` |
| `/api/credentials/buckets` | storage keys and endpoint URLs (`https://<id>.r2.cloudflarestorage.com`) |
| `/api/restore/<id>/apply` | confirmation text, plus an optional Global API key and email |

**B. Skip specific rules on endpoints that carry configuration**

| Endpoint | Body | Likely to fire | Skip |
|---|---|---|---|
| `POST /api/restore/<id>/plan` | Terraform addresses: `cloudflare_ruleset.zone_abc["http_request_firewall_custom"]`, `module.x.cloudflare_record.y[0]` | SQLi special-character counting | `942430`, `942431`, `942432` (restricted SQL character anomaly), `942460` (repetitive non-word characters) |
| `POST /api/runs`, `POST /api/presets` | Backup config: output folder (`./data/backups/…`, `C:\…`), zone name filter (`*.example.com`), zone IDs | Path traversal / LFI, OS command (Windows paths), SQLi character counting | `930100`, `930110`, `930120` (path traversal, OS file access), `932110`, `932115` (Windows command injection), `942430`, `942431`, `942432` |
| `PUT /api/settings` | Console settings: folder paths, host lists, retention numbers | Same as above | `930100`, `930110`, `930120`, `942430`, `942431` |
| `POST /api/approvals/<id>/reject` | Free-text reason | SQLi/XSS on ordinary sentences (quotes, "or", "--") | `942100`, `942200`, `942260`, `942330`, `942370`, `942430`, `942431`, `942432` |

Example exception for the restore plan:

```
(http.host eq "console.ak-cflabs.com" and http.request.method eq "POST" and starts_with(http.request.uri.path, "/api/restore/") and ends_with(http.request.uri.path, "/plan"))
```

→ **Skip: specific rules of the Cloudflare OWASP Core Ruleset** → 942430, 942431, 942432, 942460.

Make one exception per row in the same way.

**C. Never skip OWASP for**

- Any `GET` request (no body; only the URL, which holds IDs).
- `/api/credentials/<id>/reveal`: its body is just a field name. A hit there is worth seeing.
- `/api/cloudflare-audit/revert` and `/revert/plan`: the bodies only hold IDs and a timestamp.
- `/api/restore` (prepare), `/api/tools`, `/api/approvals/<id>/approve`, `/withdraw`, `/cancel`:
  only IDs and fixed values.

If one of these fires, look at it as a real attack first.

**Paranoia level:** most of the false positives in table B come from rules at **PL2 and above**
(the `942430`-family counters among them). If you'd rather have fewer exceptions, run OWASP at
**PL1** with threshold **Medium**. That gives fewer false positives at the cost of some coverage.
At PL1, only table A is normally needed.

### 11.7 Page Shield / client-side security (add-on)

Turn it on and filter by host `console.ak-cflabs.com`. The console loads scripts only from itself,
plus `challenges.cloudflare.com` when Turnstile is on, so **any other script is an alert**. Set a
notification for **New scripts** and **New connections** on this host. You don't need Page Shield
CSP policies; the console sends its own CSP.

### 11.8 Logs and alerts

- **Logpush → HTTP requests** to your SIEM or R2, filter `ClientRequestHost eq "console.ak-cflabs.com"`.
  Include `ClientIP`, `ClientRequestPath`, `ClientRequestMethod`, `EdgeResponseStatus`,
  `OriginResponseStatus`, `SecurityAction`, `SecurityRuleID`, `BotScore`, `WAFAttackScore`,
  `LeakedCredentialCheckResult` and `JA4`.
- **Logpush → Firewall events**, same filter.
- **Notifications:** *Security Events alert* (spike in blocked requests) and *Advanced Security
  Events alert* for the console's host, plus the Page Shield alerts from 11.7.
- Never log request bodies: they hold passwords, the vault password and API tokens.

### 11.9 API Shield (add-on, optional)

- **Session identifier:** cookie `cfbc_session`.
- **Endpoint management:** let it discover the `/api/*` endpoints, then save them.
- **Volumetric abuse detection:** on, to suggest per-endpoint limits from real traffic. Compare
  them with §11.4.
- **Schema validation:** skip; the console doesn't ship an OpenAPI schema.
- **mTLS:** not needed. People use a browser, and Access (§7.4) covers identity.

### 11.10 Custom error pages

If you set up custom error pages (**Rules → Custom Error Rules**) for 5xx or 1xxx errors, limit them
to non-API paths. The console's UI expects JSON from `/api/*`, and an HTML error page shows up as
a confusing parse error.

```
(http.host eq "console.ak-cflabs.com" and not starts_with(http.request.uri.path, "/api/"))
```

### 11.11 Origin protection

Authenticated Origin Pulls and Cloudflare's dedicated egress IPs don't help here, because Vercel
can't check client certificates or limit by source IP on standard plans. The **origin secret
header (§4) stays the protection.** Cloudflare Access (§7.4) is still the best way to limit who can
reach the console at all.
