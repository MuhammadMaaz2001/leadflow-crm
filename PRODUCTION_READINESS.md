# Production readiness report

Date: 2026-11-24 · Branch `claude/dreamy-sagan-nvy31g` · Scope: security, reliability, deployment architecture and operations — no new CRM features.

## 1. Verdict

**Not declared production-ready.** The application is now ready for a **staging deployment and a controlled, monitored beta**, and every item that could be verified inside the
development environment passes. The items below are *not* verified or not done, and each one is a launch blocker until someone checks it on real infrastructure:

| # | Blocker / open risk | Why it matters | What closes it |
|---|---|---|---|
| B1 | **Nothing has been deployed to a real host.** The `Dockerfile`, `deploy/` files and hosting recipes were written but never built (no Docker daemon here); TLS termination, `TRUST_PROXY` hop count and cookie behaviour behind a real load balancer were not exercised. | First deploy may fail or mis-identify client IPs (rate limiting). | Build the images in CI, deploy to staging, run `check:config`, `db:verify`, the e2e suite against it. |
| B2 | **SMTP delivery was never run against a real server.** The provider interface, outbox, retries and status tracking are tested with a test double; the nodemailer transport itself is untested here. | Verification / invitation / reset emails are essential. | Send real mail from staging; configure SPF/DKIM/DMARC. |
| B3 | **S3 adapter tested against an in-process fake S3 only** (no signature verification, one vendor-neutral path-style API) — and it now also carries **lead attachments and import files** (get/put/delete/list/stream), not only logos. | Attachments, imports and logos could behave differently on a real provider (listing/pagination, streaming, permissions). | Test against the real bucket (or MinIO) in staging: upload/download/delete an attachment, run a 100k-row import, check the orphan sweeper. |
| B4 | **Managed PostgreSQL/Redis specifics untested:** TLS (`sslmode`, `rediss://`), PgBouncer, failover, backups/restore drill, PITR. | Recovery plans are only documentation until rehearsed. | Restore drill in staging (docs/BACKUP_RECOVERY.md), then `db:verify`. |
| B5 | **No two-factor authentication** (platform administrators and workspace owners). **OIDC single sign-on is implemented but verified only against a local mock provider** — no real Entra/Google/Okta tenant has been tried; SAML is not implemented. | A stolen super-admin password exposes billing/plan control (not tenant CRM data). SSO provider quirks (claims, `email_verified`, clock skew) are unknown until tested. | Add 2FA for platform roles (or restrict platform login by network); run the SSO flow against each provider you intend to support in staging (docs/SSO.md). |
| B6 | **Load numbers come from one shared 4-core VM** (PostgreSQL, Redis, API, worker and the load generator competing for the same CPUs). PostgreSQL was the bottleneck; a second API instance did **not** raise throughput here. | Throughput on real infrastructure is unknown; "horizontal scalability" is proven for *correctness* (shared limits, locks, isolation), **not for throughput**. | Repeat `scripts/loadtest-*` against staging with a separate database host. |
| B7 | **Broad searches** (a term matching thousands of leads) still cost ≈ 0.5 s at 250k leads because their exact `count(*)` is evaluated under row level security. *Selective* searches (rare term, e-mail, phone, multi-term) were fixed: ≈ 1.1–1.6 s → 12–25 ms at 250k (docs/SEARCH_BENCHMARKS.md). | Large workspaces still see ~0.5 s for very common terms. | Fine for the shipped plan caps (professional = 25,000 leads); for larger plans add a capped/approximate total for broad searches or a dedicated search service. |
| B8 | No soak test (hours), no fault-injection test with real network partitions, no external penetration test or accessibility audit, browser coverage = Chromium only. | Unknown long-run behaviour (leaks, pool exhaustion over days). | Run a 24 h soak in staging; schedule a pen test. |
| B9 | Content-Security-Policy keeps `style-src 'unsafe-inline'` (the toast library injects a `<style>`); scripts are strict (nonce, no inline, no eval). | CSS injection remains possible if an HTML injection bug appeared. | Replace/patch the toast library or add style nonces. |
| B10 | Payments are **manual only** (by design). A **Prometheus exporter is now built in** (separate protected listener, tested in-process and against real API/worker processes) — but **no Prometheus/Grafana was run against it** and the alert rules / dashboard are syntax-checked only. | Operators must validate the monitoring stack in staging. | Scrape staging, fire a test alert, load the dashboard (docs/MONITORING.md). |
| B11 | **Uploaded files are validated by content but not scanned for malware.** Office documents and PDFs can carry active content; the API serves them only as sandboxed downloads and refuses executables, scripts, markup and macro-enabled Office files, but there is no antivirus integration. | A malicious document uploaded by a member could harm the colleague who opens it locally. | Add a scanning step (ClamAV or a vendor) between upload and availability, or restrict who may upload. |
| B12 | **A deliberate row-level-security exception exists** for search: `lf_search_lead_ids()` runs as a `BYPASSRLS` role. It is constrained (column-level grants, isolation by `app_org_id()` inside the function, `EXECUTE` only for the app role, checked by `db:verify`, covered by tenant-isolation tests) but it is new privileged code. | A future edit to that function could weaken tenant isolation. | Security review of the migration/function before launch; keep `db:verify` in the deploy pipeline; `SEARCH_STRATEGY=ilike` removes its use. |
| B13 | **Import throughput depends on PostgreSQL statistics** (400 rows/s on a fresh database before autovacuum analysed it, 1,200–1,950 rows/s warm) and was measured on one shared VM only. | Very large first imports into a fresh database can be slower than the headline numbers. | `ANALYZE` after bulk loads; re-measure on staging hardware. |

Everything else requested is implemented and covered by automated tests (details below).

**Update 2026-11-25 (second phase: attachments, calendar, background imports, search, metrics, SSO — see the rows B3, B5, B7, B10–B13 above and §5.2).** 

**Update 2026-11-25 (feature-completion phase).** B1–B9 are unchanged — none of them can be closed from the development environment. B10 is clarified: payments are manual **by decision**, and that workflow is now complete and database-enforced (see [FEATURE_MATRIX.md](FEATURE_MATRIX.md) §7). New residual risks introduced or revealed by this phase: (a) the only record of confirmed payments is PostgreSQL, so the restore drill must include the ledger reconciliation described in docs/BACKUP_RECOVERY.md; (b) platform billing admins are powerful and have no 2FA (B5 now also protects billing); (c) import is synchronous (2,000 rows) and exports are capped at 20,000 rows.

## 2. What was done

### 2.1 Dependency security
`npm audit` before: **9 advisories (2 critical, 4 high, 3 moderate)** across the workspaces. After: **0** (`npm audit` and `npm audit --omit=dev`, run on the date above; this is a point-in-time result — run it in CI).

| Advisory chain | Where it lived | Action | Real-world risk before the fix |
|---|---|---|---|
| `vitest` ≤ 4.1.10 → `tinypool` (critical, prototype-pollution RCE gadget), `@vitest/mocker` (path traversal / code injection) | API test runner (dev only) | Upgraded `@leadflow/api` to **vitest 5.1.1** (same major the web app already used); all suites pass | Developer machines / CI only; not in production artefacts |
| `prisma` → `@prisma/config` → `effect` ≤ 3.22.0 (ReDoS), `deepmerge-ts` < 8 (stack exhaustion) | Prisma **CLI** (migrations/generate), not the running API | npm `overrides`: `effect ^3.22.5`, `deepmerge-ts ^8.0.2`; verified `prisma generate`, `migrate deploy`, `migrate status`. npm's own "fix" (downgrade Prisma to 6.12.0) was rejected | Only when the CLI parses attacker-controlled config — not the case |
| `exceljs` → `uuid` < 11.1.1 (buffer bounds check in v3/v5/v6 when a `buf` argument is given) | Excel import/export | npm `overrides`: `uuid ^11.1.1`; import/export tests pass | Not exploitable: exceljs only calls `v4()` without a buffer |

The two `overrides` are workarounds — remove them once Prisma and exceljs publish releases that depend on the fixed versions. Also changed: `bcryptjs` → native **`bcrypt` 6** (pure-JS hashing blocked the event loop and capped login at ~12/s per process; native is ~4× faster and off-thread; hashes are format-compatible so no user is affected); `nodemailer` **10.x** (7.x had open advisories); `@aws-sdk/client-s3`; `autocannon` (dev).

### 2.2 Security hardening (review → finding → status)
| Area | Result |
|---|---|
| **Content-Security-Policy** | Web: per-request nonce policy (`apps/web/src/proxy.ts`): `script-src 'self' 'nonce-…' 'strict-dynamic'` (no inline, no eval), `connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri/form-action 'self'`. Verified in Chromium on 14 screens: **zero violations**; injected inline script and inline handlers do not run (`e2e/security.spec.ts`). Zod's JIT (`new Function`) is disabled in browsers. API: default-deny CSP (Swagger UI gets its own relaxed one, and is off in production). Known relaxation: B9. |
| **Headers** | HSTS (2 y, includeSubDomains), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `COOP same-origin`, `Cache-Control: no-store` on API responses, `X-Powered-By` removed (web + API). |
| **CORS** | Exact-origin allow-list from `WEB_URL` (https only in production), credentials, explicit methods/headers; foreign origins get no CORS headers (tested). |
| **CSRF** | Origin / `Sec-Fetch-Site` guard on every state-changing request + SameSite=Lax cookie; cross-site POST → 403 (tested). |
| **Sessions / auth** | httpOnly, Secure, SameSite=Lax cookie named `__Host-lf_session` in production (browser enforces Secure + Path=/ + no Domain); token stored hashed; idle timeout (7 d) + absolute TTL (14 d); logout/password change/reset revoke sessions server-side; login lockout (5 failures → 15 min) which — a bug found in the previous audit — now actually persists; per-IP **and per-account** login rate limits (credential stuffing); timing-safe unknown-user path. |
| **Password reset / email verification** | Tokens: 256-bit random, SHA-256 at rest, expiring (1 h reset / 24 h verify), **single-use enforced atomically** (found: check-then-update race → concurrent redemption; fixed with a conditional update, tested with 6 parallel requests), a new link invalidates the previous one, forgot-password never reveals whether an account exists, per-address hourly limit. Invitations: bound to the invited email, single-use atomic. |
| **Uploads** | Content validated by magic bytes, zip-bomb check on xlsx, row/column caps, CSV formula-injection neutralised, logos: raster only (PNG/JPEG/WebP/GIF), 400 KB, bytes must match declared type; with S3 the bucket stays private and objects are served by an authenticated workspace-scoped route with `sandbox` CSP. |
| **Rate limiting** | Redis-backed, shared by all instances (§2.3). |
| **Secrets in bundles / logs** | `npm run scan:secrets` scans the built browser bundles (66 files) for the values of every secret-like variable and for credential patterns: none. Logger redacts password/token/cookie/authorization/API-key fields, credentials inside URLs and `token=` query values; access logs record the route pattern, never query strings or cookies; slow-query log keeps parameterised SQL only (tested). |
| **Platform administrators** | Roles SUPER / SUPPORT / BILLING enforced per route (tested); the platform DB role has **no SELECT** on leads, opportunities, follow-ups, tasks, activities, notifications, mailbox (tested via catalogue); suspension/adjustments are audit-logged. Gap: no 2FA (B5). **New:** tenants can no longer mark their own invoices paid outside development (a real production hole in the manual-payment design). |
| **PostgreSQL RLS in production configuration** | `db:verify` (CLI + test): RLS enabled **and forced** + policy on every table with `organization_id`, runtime role not superuser/BYPASSRLS/CREATEROLE, platform role without SELECT on CRM tables, app role cannot DELETE history tables or CREATE in `public`. The API probes its own database role at start-up and **refuses to start** in production if it could bypass RLS; `check:config` rejects owner credentials in `APP_DATABASE_URL`. |

### 2.3 Distributed infrastructure
| Requirement | Implementation | Evidence |
|---|---|---|
| Shared rate limiting | Redis fixed-window counters, one atomic Lua script per hit; per-IP, per-account and per-address limits; 5 s circuit breaker → per-process fallback if Redis is down | Two separate Express apps + 30 concurrent requests: exactly 10 allowed, 20 × 429 (limit is global, not per instance); separate key prefixes isolate; fallback keeps limiting with no 5xx |
| Scheduler coordination | Redis lease lock (`SET NX PX`, timer-renewed, compare-and-delete release); a crashed holder's lease expires | 12 contenders → exactly 1 winner; expired "crashed" lease is taken over; stale holder cannot release the new owner's lock; lease renewed while work runs 2.5× the TTL; lost lease detected; 5 simultaneous scheduler ticks → exactly 1 runs |
| No duplicate automation/notifications | Idempotency at the data layer, so correctness never depends on the lock: unique keys + `skipDuplicates`, `SELECT … FOR UPDATE` on executions, atomic status claims | 3 concurrent un-locked ticks → exactly one task / unique executions; the same execution delivered 3× concurrently → exactly 1 task |
| Crashed workers / stalled jobs | BullMQ stalled detection (`stalledInterval` 30 s, `maxStalledCount` 2); heartbeat in Redis; lost/never-enqueued work re-queued by the scheduler (`PENDING` executions > 5 min, unsent emails) | A job whose worker "died" mid-run is picked up by another worker; Redis-flush recovery test |
| Retries & backoff | 5 attempts, exponential from 5 s; final failure kept 14 days + reported via the error hook | Transient failure → succeeds on 3rd attempt with growing delays; permanent failure → exactly 5 runs, stays in the failed set, reported |
| Duplicate processing | Job ids (`ex-<id>`, `email-<id>`), row locks | 4 concurrent `add()` with one id → processed once |
| Graceful shutdown | SIGTERM/SIGINT → readiness 503 → HTTP drain → worker finishes running jobs → queue/Redis/Prisma closed, bounded by `SHUTDOWN_TIMEOUT_MS`; `uncaughtException` reported + exit | Real **processes**: API exits 0 with `shutdown complete`; worker clears its heartbeat and exits 0; in-flight job completes on `worker.close()`; a failing shutdown step is reflected in the exit code |
| Multiple API instances | Stateless apps; Redis for limits/locks | Two instances: shared limits; 120 concurrent requests across two instances, interleaved reads/writes of two workspaces — no cross-tenant rows, no errors |

### 2.4 Database and reliability
* **Pooling:** Prisma pools sized by `DB_POOL_MAX` (20) / `DB_PLATFORM_POOL_MAX` (5) per process, `pool_timeout` 20 s; sizing rule `instances × 25 < max_connections` in DEPLOYMENT.md; PgBouncer transaction mode is compatible (`set_config(..., true)` is transaction-local) but **was not tested**.
* **Transactions:** one transaction per request with tenant context; jobs/emails are enqueued only after commit (`afterCommit`), and now recovered by sweepers if the enqueue is lost. New role-level guards (migration `role_timeouts`): `statement_timeout` 60 s (platform 30 s), `lock_timeout` 15 s, `idle_in_transaction_session_timeout` 120 s.
* **Indexes:** verified by test (every FK indexed), by EXPLAIN on 30k/100k/250k leads (see §3) and with the new slow-query log. Remaining sequential scans are aggregates over the whole workspace (dashboard) and `ILIKE` search — see §3.
* **Migrations:** *empty database* — every API test run recreates `leadflow_test` from all 10 migrations; *existing populated database* — `scripts/migration-compat.sh` builds a database at the original 3-migration schema, inserts data, upgrades through the remaining 7, proves row counts are unchanged, legacy rows are back-filled correctly (`status=SENT`, `provider=dev`) and `db:verify` passes (**passed**). All new migrations are additive (email outbox columns, `payment_events` table, role timeouts).
* **UTC/timezones:** all timestamps are `timestamptz` (tested); reporting uses the workspace timezone; the API serialises ISO-8601 UTC. Known limitation (unchanged): `datetime-local` inputs use the browser's timezone.
* **Concurrency & tenant isolation:** the concurrent two-workspace/two-instance test above, plus single-use token races (reset token ×6, invitation ×5), payment double-record (×4), duplicate provider events (×5) — each yields exactly one effect.
* **Backup/recovery:** `docs/BACKUP_RECOVERY.md` (strategy, restore procedure, partial recovery, Redis-loss behaviour). The restore *drill* itself is B4.

### 2.5 Providers (nothing is pretended)
* **Email:** outbox in the same transaction as the business change → worker → `EmailProvider` (`dev` mailbox preserved, `smtp` via nodemailer, `none`). Status is stored truthfully (`QUEUED → SENT | FAILED (retried) | UNDELIVERABLE`); with no provider mails are **never** marked sent; production refuses `EMAIL_TRANSPORT=dev`; one-time links are scrubbed from rows after real delivery. Tested: dev delivery, no-provider (UNDELIVERABLE), outage → FAILED → swept → SENT.
* **Payments:** manual recording kept (platform billing admins; tenant self-recording only in development). Lifecycle review found and fixed: a tenant could self-declare payment in production, and two concurrent payments could extend a subscription twice. New provider-independent `PaymentProvider` contract + a hardened settlement routine (exactly-once by `(provider,eventId)`, amount/currency must match, never fabricates success) with a `payment_events` ledger. No provider is integrated.
* **Storage:** `ObjectStorage` with `db` (default) and `s3` providers (B3).

### 2.6 Monitoring and operations
Structured JSON logging with request ids (`X-Request-Id` honoured when sane, echoed, propagated to every log line and to the 500 response body), one access-log line per request, slow-query log, error-reporting hook (`setErrorReporter` / `ERROR_WEBHOOK_URL`), `/api/health/live`, `/api/health/ready` (PostgreSQL required, Redis → degraded, 503 while draining), worker heartbeats + scheduler last-run surfaced in `/platform/health`, optional worker health port, graceful shutdown. Runbook: `docs/RUNBOOK.md`.

## 3. Load and performance measurements

**Method.** `apps/api/src/scripts/loadtest/` (data generator, scenario runner on autocannon, EXPLAIN tool) and `scripts/loadtest-db.sh`. A separate database (`leadflow_load`) was created from the migrations; one workspace per dataset was created through the product API and bulk-filled with SQL (realistic shape: 8 % of leads have an opportunity, 6 % a follow-up, 40 % activity history, 22 users, 500 notifications each). One API process and one worker (production build, `NODE_ENV=development` only to enable the test-data endpoints, access log off, rate limiter off so authentication could be loaded), 20 virtual users per scenario (100 for the mixed run), 15 s per scenario (30 s mixed), cookies of 11 real sessions (1 manager, 10 agents; agents only see their own leads, as in production).

**Hardware / environment:** 4 vCPU Intel Xeon @ 2.1 GHz, 16 GB RAM, **PostgreSQL 16, Redis 7, Node API, worker and the load generator all on the same machine** (CPU contention affects every number; the PostgreSQL backends together used > 200 % of a CPU during the mixed run, each API process 25–40 %). Treat the figures as *relative indications of how cost grows with data volume*, not as capacity guarantees for production hardware. Single run per scenario, no repetitions, so small differences are noise. Error rate = non-2xx responses + connection errors; the 0.37 % in the first mixed run were harness 404s (an agent requested a lead id that was not hers).

### 3.1 Results (before the large-workspace cache)
| Scenario (20 connections unless noted) | 30k leads: req/s · p50/p90/p99 ms · errors | 100k leads: req/s · p50/p90/p99 ms · errors | 250k leads: req/s · p50/p90/p99 ms · errors |
|---|---|---|---|
| auth-login | 52 · 179/239/399 · 0% | 55 · 176/210/275 · 0% | 49 · 183/287/396 · 0% |
| leads-list | 153 · 123/162/263 · 0% | 85 · 225/315/421 · 0% | 48 · 410/567/697 · 0% |
| leads-list-deep-page | 124 · 157/204/247 · 0% | 66 · 301/383/481 · 0% | 25 · 804/886/1045 · 0% |
| leads-search | 102 · 181/264/418 · 0% | 45 · 382/685/1554 · 0% | 19 · 928/1661/2923 · 0% |
| leads-filter-sort | 155 · 125/158/210 · 0% | 95 · 194/286/491 · 0% | 46 · 337/834/1465 · 0% |
| lead-detail | 255 · 76/91/109 · 0% | 247 · 76/96/135 · 0% | 273 · 71/84/114 · 0% |
| lead-create | 76 · 259/301/338 · 0% | 72 · 269/319/377 · 0% | 59 · 330/384/453 · 0% |
| lead-assign | 184 · 107/127/171 · 0% | 181 · 108/126/169 · 0% | 173 · 112/144/214 · 0% |
| pipeline-board | 49 · 398/465/520 · 0% | 28 · 670/797/961 · 0% | 30 · 654/790/893 · 0% |
| dashboard | 68 · 280/338/505 · 0% | 43 · 390/821/1303 · 0% | 23 · 649/1059/3212 · 0% |
| reports | 239 · 76/116/201 · 0% | 123 · 101/501/676 · 0% | 50 · 226/1418/1773 · 0% |
| notifications | 444 · 44/55/69 · 0% | 458 · 42/52/64 · 0% | 384 · 49/67/96 · 0% |
| followups-tasks | 292 · 65/89/112 · 0% | 326 · 59/74/90 · 0% | 282 · 68/87/121 · 0% |
| MIXED-100-users | 144 · 556/1257/1823 · 0.37% | 93 · 830/2435/3252 · 0% | 38 · 1767/3885/6610 · 0% |


### 3.2 After the large-workspace result cache
Findings from the table above and the plans: list `count(*)`, dashboard aggregates and reports cost O(workspace size) per request (e.g. `count(*)` 9 ms → 31 ms → 70 ms; dashboard status aggregate 14 → 61 → 131 ms; about 15 statements per dashboard). I added a short-TTL (20 s) Redis cache **only for workspaces with ≥ 20,000 leads** (decided from the daily usage snapshot), keyed by workspace and data scope; smaller workspaces keep exact, immediately consistent numbers (tests prove both behaviours, scope separation, and fallback when Redis fails).

**After the large-workspace result cache** (same dataset and machine; scenarios it affects):

| Scenario | 100k before → after (req/s · p50 ms) | 250k before → after (req/s · p50 ms) |
|---|---|---|
| leads-list | 85 · 225 → **265 · 72** | 48 · 410 → **264 · 72** |
| leads-list-deep-page | 66 · 301 → **91 · 220** | 25 · 804 → **43 · 464** |
| leads-search | 45 · 382 → **109 · 152** | 19 · 928 → **40 · 396** |
| leads-filter-sort | 95 · 194 → **178 · 107** | 46 · 337 → **84 · 172** |
| dashboard | 43 · 390 → **555 · 33** | 23 · 649 → **513 · 35** |
| reports | 123 · 101 → **637 · 30** | 50 · 226 → **615 · 30** |
| MIXED-100-users | 93 · 830 → **183 · 363** | 38 · 1767 → **132 · 385** |

**Two API instances** (250k leads, 100 virtual users split 50/50, same database and Redis): 62 + 63 = **125 req/s** (p50 411/399 ms, p99 4486/4038 ms, errors 0%/0%) versus **132 req/s** with one instance and 100 users (p50 385 ms, p99 3735 ms).

**Dataset sizes:** 30k: 30,000 leads, 2,137 opportunities, 1,592 follow ups, 758 tasks, 23,844 activities, 11,500 notifications · 100k: 100,000 leads, 7,069 opportunities, 5,276 follow ups, 2,625 tasks, 79,572 activities, 11,500 notifications · 250k: 250,000 leads, 17,780 opportunities, 13,329 follow ups, 6,555 tasks, 199,410 activities, 11,500 notifications

### Statement timings (EXPLAIN ANALYZE as `leadflow_app` under row level security, warm cache, single execution)

| Statement | 30k | 100k | 250k | Plan (250k) |
|---|---|---|---|---|
| leads list (page 1, newest first) | 0.292 ms | 0.143 ms | 0.216 ms | Index Scan using leads_active_idx on leads  |
| leads list count(*) | 8.75 ms | 27.865 ms | 76.657 ms | Index Only Scan using leads_inactivity_scan_idx on leads  |
| leads list, agent scope (own leads) | 3.9 ms | 0.727 ms | 0.447 ms | Seq Scan on leads leads_1  |
| leads list, status filter + sort by last activity | 0.251 ms | 0.167 ms | 0.372 ms | Index Scan Backward using leads_inactivity_scan_idx on leads  |
| leads search ILIKE %smith% (name/email/company/phone) | 6.137 ms | 4.495 ms | 6.145 ms | Index Scan using leads_active_idx on leads  |
| leads search, rare term (worst case: scans the workspace) | 68.094 ms | 226.032 ms | 647.902 ms | Index Scan using leads_active_idx on leads  |
| duplicate check by normalised e-mail (lead create) | 0.042 ms | 0.043 ms | 0.055 ms | Index Scan using leads_organization_id_email_normalized_idx on leads  |
| plan limit: count of active leads (lead create) | 7.558 ms | 27.126 ms | 73.331 ms | Index Only Scan using leads_inactivity_scan_idx on leads  |
| dashboard: leads by status | 14.658 ms | 41.579 ms | 122.918 ms | Seq Scan on leads  |
| dashboard: leads created per day (30 days) | 2.144 ms | 3.936 ms | 8.915 ms | Index Only Scan using leads_active_idx on leads  |
| dashboard: leads by source | 2.875 ms | 5.306 ms | 15.38 ms | Bitmap Heap Scan on leads  |
| pipeline: open value per stage | 0.98 ms | 3.216 ms | 10.39 ms | Seq Scan on opportunities  |
| pipeline: cards of one stage (60) | 0.367 ms | 0.979 ms | 2.748 ms | Seq Scan on opportunities opportunities_1  |
| follow-ups: due today / overdue | 0.081 ms | 0.093 ms | 0.14 ms | Index Scan using follow_ups_pending_due_idx on follow_ups  |
| notifications: unread count for a user | 0.762 ms | 1.424 ms | 5.221 ms | Seq Scan on notifications notifications_1  |
| scheduler: uncontacted leads scan | 0.207 ms | 5.355 ms | 17.282 ms | Seq Scan on leads  |
| scheduler: inactive leads scan | 75.085 ms | 0.186 ms | 0.166 ms | Seq Scan on leads  |
| activity timeline of one lead | 0.086 ms | 0.063 ms | 0.058 ms | Seq Scan on leads  |


### 3.3 Interpretation — what these numbers do and do not say
* **Within the shipped plan limits** (professional = 25,000 leads per workspace) the 30k column is the relevant one: lists answer in ~120 ms p50, search ~180 ms, lead creation ~260 ms, dashboard ~280 ms p50 (uncached; with the cache the 100k/250k datasets measured ~35 ms) at 20 concurrent users on a *shared* 4-core box, with **0 errors** in every single-endpoint scenario (the 100-user mix had 0.37 % harness 404s).
* **Login** is CPU-bound by bcrypt: 12 → ~52 logins/s per process after switching to native bcrypt (10 connections, p50 180 ms).
* **Bottlenecks, in order:** (1) **PostgreSQL CPU** for whole-workspace scans — `ILIKE` search (worst case 68 ms / 226 ms / 648 ms for one rare-term query at 30k / 100k / 250k; common terms stop early), exact `count(*)`, aggregates; (2) the Node process (JSON + Prisma marshalling) for the kanban board (30–50 req/s) and dashboard when uncached; (3) `OFFSET` pagination at very deep pages (page 5,000 of 250k: 464 ms).
* **Scaling out:** with the database already saturated, a second API instance gave **no** extra throughput (125 vs 132 req/s). So: the API tier *can* be scaled horizontally without correctness problems (proved by the shared-limit, lock, idempotency and isolation tests), but *whether it raises throughput depends on database capacity*, which this environment could not demonstrate. **No throughput scalability claim is made.**
* **Not measured:** soak/endurance, memory growth over time, network latency to a remote database, PgBouncer, browser rendering performance, import/export of large files under load, platform-admin screens, notification fan-out at scale.

### 3.4 Background import throughput (2026-11-25)
`apps/api/test/import-bench.test.ts` (opt-in: `IMPORT_BENCH_ROWS=100000 npx vitest run test/import-bench.test.ts`), same VM, real PostgreSQL/Redis, local-disk storage, inline worker, batch size 500, one workspace, 7 columns, all rows valid and unique:

| Rows | File | Upload + preview (request) | Processing | Throughput | Peak RSS increase |
|---:|---:|---:|---:|---:|---:|
| 20,000 | 1.0 MB | 0.1 s | 12.7–16.6 s (warm statistics) / 53.7 s (cold statistics, fresh database) | 1,200–1,580 / 372 rows/s | +119–138 MB |
| 100,000 | 5.3 MB | 0.19 s | **51.3 s** | **1,948 rows/s** | +136 MB |

Per-batch cost (500 rows): lead insert ≈ 80–100 ms, tags ≈ 20–50 ms, activities ≈ 40–90 ms; the first batch also pays ≈ 1.1 s to start automations for the first 200 leads. Memory is flat (the file is streamed; only one batch of rows is held). The upload request counts rows with Papa Parse's synchronous `step` mode (the object-stream variant needed > 120 s at 100,000 rows and exceeded the request transaction — found and fixed by this benchmark). **Cold statistics:** PostgreSQL caches foreign-key check plans per connection; on a freshly created database they are planned for tiny tables and the cost grows with the workspace until autovacuum analyses the tables, which is why the first run was 3–4× slower. Not measured: concurrent imports from several workspaces, S3 latency, XLSX at 100k rows, a separate database host.

## 4. Deployment architecture
See **DEPLOYMENT.md** (roles, migrations, rollout, first-time setup), `Dockerfile` (targets `web`, `api`, `worker`, `migrate`), `deploy/api.env.example`, `deploy/web.env.example`, `deploy/docker-compose.example.yml`, `docs/BACKUP_RECOVERY.md`, `docs/RUNBOOK.md`. Frontend: Next.js on any Node-capable host or Vercel; API and worker: persistent Node 22 processes (Render/Fly/Railway/ECS/Cloud Run with always-on CPU/Kubernetes); managed PostgreSQL 16 and Redis 7; S3-compatible storage; SMTP provider. Configuration is validated by `npm run check:config`; the API/worker refuse to start in production with an unsafe environment (tested with real processes). No secrets are committed (`deploy/*.example` contain placeholders only; `.gitignore` excludes `deploy/.env*`).

## 5. Verification run (2026-11-24)
| Check | Result |
|---|---|
| `npm run lint` (zero warnings) | clean |
| `npm run typecheck` (strict; shared, api, web) | clean |
| API tests (Vitest + Supertest, real PostgreSQL + Redis, DB recreated from migrations) | **134 / 134** (12 files) |
| Web unit tests | **20 / 20** |
| Playwright e2e (Chromium, production web build, Playwright-started servers) | **28 / 28** |
| `npm run build` (shared → Prisma client → API → Next.js) | succeeds |
| `npm audit` / `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run scan:secrets` | no secrets in browser bundles |
| `npm run db:verify` on the dev database | passed |
| `scripts/migration-compat.sh` (populated old-schema DB → current) | passed |
| `npm run docs:api` | 155 endpoints documented |
| Docker images, hosting platforms, real SMTP, real S3, managed PostgreSQL/Redis | **not run** (B1–B4) |

New automated tests added in this phase: infrastructure/idempotency/concurrency (24), operations/config/logging/headers/health/shutdown (17), real-process tests (3), storage (5), payments (7), database verification (1), web CSP (4), Playwright security (2) — 63 in total.

### 5.1 Re-run after the feature-completion phase (2026-11-25)
| Check | Result |
|---|---|
| `npm run lint` / `npm run typecheck` | clean |
| API tests | **198 / 198** (20 files) |
| Web unit tests | **20 / 20** |
| Playwright e2e (production web build) | **30 / 30** |
| `npm run build` | succeeds |
| `npm audit` | 0 vulnerabilities |
| `npm run scan:secrets` | no secrets in 64 browser bundle files |
| `npm run db:verify` | passed (14 migrations applied, none unfinished) |
| `scripts/migration-compat.sh` | passed (old-schema database upgraded in place) |
| `npm run docs:api` | 164 endpoints |
| Load tests, Docker build, real SMTP/S3/managed DB | **not re-run / not run** (B1–B4, B6) |

### 5.2 Verification run after the second phase (2026-11-25)
| Check | Result |
|---|---|
| `npm run lint` / `npm run typecheck` | clean |
| API tests (real PostgreSQL + Redis) | **289 passed, 1 opt-in benchmark skipped** (27 files; +91 new tests: attachments 16, calendar 12, imports 15, search 11, metrics 11, SSO 25, storage list 1) |
| Web unit tests | **20 / 20** |
| Playwright (production build) | **36 / 36** (+6: attachments, calendar drag/rollback/dialog/viewer, background import with history, SSO through a mock provider; two earlier specs referenced a label that no longer existed and were corrected) |
| `npm run build` | succeeds |
| `npm audit` | 0 vulnerabilities (new dependencies: `prom-client`, `openid-client` 5.7.1, `jose` for tests) |
| `npm run scan:secrets` | no secrets in 66 browser bundle files |
| `npm run db:verify` | passed (21 migrations applied, none unfinished; checks the new search function/role) |
| `scripts/migration-compat.sh` | passed (old-schema database upgraded in place) |
| `npm run docs:api` | 186 endpoints |
| Real-process smoke | API + worker started with `METRICS_PORT`/`WORKER_METRICS_PORT`: 401 without token, metrics with token, 404 on the public API port; non-loopback host without token refused |
| Search benchmark | 30k / 100k / 250k leads, before/after (docs/SEARCH_BENCHMARKS.md) |
| Import benchmark | 20k and 100k rows (§3.4) |
| Real S3, SMTP, OIDC provider, Prometheus/Grafana, Docker, managed PostgreSQL/Redis, antivirus | **not run** (B1–B5, B10–B11) |

## 6. Pre-launch checklist
1. Build and deploy to staging from `main`; run `check:config`, migrations, `db:verify`, the full e2e suite against it (B1).
2. Real SMTP + S3 credentials in staging; send/receive each email type; upload/replace/remove a logo (B2, B3).
3. Restore drill from the latest backup into a scratch instance + `db:verify` (B4).
4. Add 2FA (or network restriction) for platform administrators (B5).
5. Re-run the load scenarios against staging hardware with a separate database host; decide capacity per workspace; keep plan caps ≤ the size you measured (B6, B7).
6. 24-hour soak with alerts wired to: readiness 503, scheduler stale, failed jobs, 5xx rate, `UNDELIVERABLE`/`FAILED` emails (B8).
7. External penetration test; accessibility review.
8. Never run `db:seed` in production; create the first platform super admin manually (DEPLOYMENT.md §8).
9. Rehearse the manual-billing procedure end to end in staging (docs/RUNBOOK.md → Manual billing): confirm, extend, reverse, restore from backup and reconcile the ledger.
10. Upload, download and delete attachments, and run a large import, against the **real bucket** in staging; test orphan cleanup (B3).
11. Run the SSO flow against each identity provider you will support; rehearse the recovery paths in docs/RUNBOOK.md (B5).
12. Scrape staging with Prometheus, fire a test alert, load the dashboard (B10). Decide on malware scanning for uploads (B11). Security-review the `lead_search` migration (B12).
