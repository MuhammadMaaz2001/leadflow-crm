# Architecture

LeadFlow is a **modular monolith**: one API process, one worker process, one web app, one PostgreSQL database. Domain boundaries are folders, not services.

```
Browser ──► Next.js (web :3000) ──/api/* rewrite──► Express API (:4000) ──► PostgreSQL (RLS)
                                                        │
                                                        └──► Redis ◄── BullMQ worker (scheduler + automations)
```

## Repository
```
apps/api/src
  config.ts  db.ts  http.ts  openapi.ts  app.ts  server.ts  worker.ts  jobs.ts
  lib/        crypto · email (dev mailbox) · queue (BullMQ + inline mode) · audit · pagination · dates · users
  modules/    auth · organizations · members(+roles, invitations) · lookups(sources, priorities, tags, lost reasons, custom fields)
              leads(+assignment, import/export, merge) · pipelines · opportunities · followups · activities · tasks
              notifications · automations(+assignment rules, scheduler) · reports(+dashboard) · subscriptions(+billing, lifecycle)
              audit-logs · platform-admin · system
apps/web/src
  app/(auth)/…  app/onboarding  app/dev/mailbox  app/(app)/…  app/platform/…
  components/   ui/ (button, form, overlay, menu, data, table) · app-shell · dialogs · charts · calendar · filters …
  lib/          api client · session & tenant-scoped query hooks · formatters · url-state
packages/database   prisma/schema.prisma + migrations (+ RLS SQL)
packages/shared     permissions, constants, zod schemas (single source of truth for validation)
```

## Request pipeline (apps/api/src/http.ts)
Every endpoint is declared with `route({ auth, perm, feature, body, query }, handler)`:

1. **Authenticate** – httpOnly cookie → `sessions` row (SHA-256 token hash, revocable, expiring).
2. **Resolve tenant** – the `X-Org-Id` header is only a *request*. The API looks up the caller's `memberships` row for that organization; no membership ⇒ `403 NOT_A_MEMBER`; deactivated ⇒ `403 MEMBER_DEACTIVATED`.
3. **Open a transaction with tenant context** – `withContext()` starts one Prisma transaction and runs `set_config('app.org_id', …)` / `app.user_id`; PostgreSQL RLS policies read those settings. All queries of the request share this transaction (AsyncLocalStorage), so multi-step operations are atomic.
4. **Workspace gates** – suspended workspace ⇒ `403`; expired subscription ⇒ read-only (`402` on writes) except billing endpoints.
5. **Authorise** – role permissions (`any-of`) then plan **feature** gates (`402 FEATURE_NOT_IN_PLAN`).
6. **Validate** – Zod (shared package). Validation runs *after* authorisation so unauthorised callers learn nothing about payload rules.
7. **Handler** – returns data; the wrapper serialises `{ data, meta? }`. Errors become `{ error: { code, message, details } }`.
8. **After commit** – hooks (e.g. enqueue automation jobs) run only once the transaction has committed.

The same `route()` declarations feed the OpenAPI document (`/api/openapi.json`, Swagger UI at `/api/docs`).

## Multi-tenancy & security (defence in depth)
| Layer | Mechanism |
|---|---|
| Identity | Global `users`; per-workspace `memberships` with per-workspace `roles` (permission arrays). One user can belong to many workspaces with different roles. |
| Application | Tenant derived from membership, never from the client; every service query also filters by `organizationId`; row visibility rules (own vs all) per permission. |
| Database | `organization_id` on every tenant table, **composite foreign keys `(id, organization_id)`** so a row can never reference another tenant's row, **RLS `FORCE`d on all tenant tables**, runtime role without BYPASSRLS. |
| Platform | Separate DB role `leadflow_platform` (BYPASSRLS) whose **table grants exclude leads, opportunities, follow-ups, activities, tasks, notifications …**. It reads accounts, plans, billing and the aggregate view `platform_org_overview` only. Platform routes live under `/api/platform` and require `users.platform_role`; role matrix: SUPER (all), SUPPORT (suspend/activate, users), BILLING (plans, subscriptions, invoices). |
| History | The app role has no UPDATE/DELETE on `audit_logs`, `lead_assignments`, `stage_history`, `follow_up_events`, `subscription_events`, `activities` (only `activities.lead_id` for merges). |
| Secrets | Passwords bcrypt-hashed (native bcrypt, cost 10, off the event loop); session/reset/verify/invite tokens stored as SHA-256 hashes; lockout after 5 failed logins; DB role passwords come from the environment. |

Tested in `apps/api/test/isolation.test.ts`: IDOR on every entity, header spoofing, cross-tenant foreign keys, raw unscoped queries under RLS, platform role denied on CRM tables, deactivated members, per-role permissions.

## Domain model highlights
* **Leads vs opportunities are separate.** A lead is a person/company; an opportunity is a deal with a pipeline, stage, value and expected close date. One lead → many opportunities. Lead lifecycle status (`NEW → CONTACTED → QUALIFIED → CONVERTED | LOST`) is *derived* from contact activity and opportunity outcomes (`syncLeadFromOpportunities`).
* **Won/Lost are real states**: `opportunities.status`, `won_at`/`lost_at` (check-constrained), `lost_reason_id`, plus `stage_history` rows. Stages have a `kind` (OPEN/WON/LOST).
* **Follow-ups** keep `follow_up_events` (created, rescheduled with from/to, completed, canceled); completion requires an outcome and records who/when. "Overdue" is *derived* (`status = PENDING AND due_at < now`), never stored.
* **Activities** are an append-only timeline written by the same services that make the change.
* **Assignments** are append-only (`lead_assignments` with method MANUAL / BULK / ROUND_ROBIN / RULE / IMPORT / MERGE).

## Distributed runtime (production)
```
Web (N)  ──/api rewrite──▶  API (N, stateless)  ──▶ PostgreSQL (RLS)         Worker (N) ──▶ PostgreSQL, Redis, SMTP
                              │ rate limits, locks ──▶ Redis ◀── BullMQ queue ──┘
                              └ logos ──▶ S3-compatible bucket (private)
```
Nothing that matters is held in process memory, so every tier scales horizontally:

| Concern | Mechanism | File |
|---|---|---|
| Rate limiting | Fixed window counters in Redis, one atomic Lua script per hit → one limit across all API instances (also per-account login and password-reset limits). If Redis is unreachable a 5-second circuit breaker switches to a per-process window instead of failing requests. | `lib/ratelimit.ts` |
| Scheduler single-flight | `scheduler.tick` runs every minute on whichever worker picks it up; inside it a Redis **lease lock** (`SET NX PX`, renewed by a timer, released with compare-and-delete) lets one instance run at a time. A crashed holder stops renewing and the lease expires. | `lib/lock.ts`, `modules/automations/scheduler.ts` |
| Idempotency (correct even if the lock is lost) | Reminders: notification `dedupeKey` unique + `createMany skipDuplicates`. Automation events: unique `(rule, eventKey)` inserted with `skipDuplicates`. Execution: `SELECT … FOR UPDATE` on the execution row + status check ⇒ exactly-once effects when a job is delivered twice. Invoice payment: atomic status claim. Single-use tokens (reset, verify, invitation): atomic claim. Emails: outbox row, job id = row id. | `engine.ts`, `events.ts`, `lifecycle.ts`, `auth/routes.ts` |
| Retries | Every job: 5 attempts, exponential backoff from 5 s; stalled jobs (worker died) re-queued, `maxStalledCount` 2; final failures kept 14 days and reported to the error hook. | `lib/queue.ts`, `jobs.ts` |
| Lost jobs (Redis flushed, enqueue failed after commit) | The scheduler re-queues automation executions still `PENDING` after 5 min and unsent outbox emails. | `scheduler.ts`, `lib/email.ts` |
| Graceful shutdown | SIGTERM/SIGINT: readiness → 503, HTTP server drains, worker stops taking jobs and waits for running ones, then queue/Redis/Prisma close; bounded by `SHUTDOWN_TIMEOUT_MS`. | `lib/shutdown.ts`, `server.ts`, `jobs.ts` |
| Health | `/api/health/live`, `/api/health/ready` (PostgreSQL required, Redis → degraded), worker heartbeats + scheduler last-run in Redis, surfaced at `/platform/health`; worker has an optional HTTP health port. | `lib/health.ts` |
| Observability | JSON logs with request id propagated through `AsyncLocalStorage`, secret redaction, one access-log line per request, slow-query log (parameterised SQL only), error-reporter hook. | `lib/logger.ts`, `lib/request.ts`, `lib/error-report.ts` |
| Start-up safety | Production configuration validation (`config-validate.ts`) and a database-role probe: the API refuses to start if its DB user is a superuser/BYPASSRLS. `npm run db:verify` re-checks RLS, roles and grants on any live database. | `config-validate.ts`, `lib/db-verify.ts` |

### Providers behind interfaces (nothing is pretended)
* **Email** (`lib/email.ts`): transactional outbox → `EmailProvider` (`dev` mailbox, `smtp`, `none`). Statuses are real: `QUEUED → SENT | FAILED (retry) | UNDELIVERABLE`. Delivered one-time links are scrubbed from the row outside development.
* **Storage** (`lib/storage.ts`): inline PostgreSQL (dev) or any S3-compatible bucket; images are validated by content first; the bucket stays private and objects are served by an authenticated, workspace-scoped route.
* **Payments** (`modules/subscriptions/payment-provider.ts`): `PaymentProvider` contract plus a single defensive settlement routine (signature-verified events only, `(provider,eventId)` exactly-once, amount/currency must match, no fabricated success). No adapter exists; tenants cannot mark their own invoices paid outside development.

## Background processing (BullMQ)
* `scheduler.tick` (repeatable, every minute; single-flight through the lease lock) iterates workspaces (`app_list_active_orgs()` returns ids only) and, **inside each tenant's RLS context**: sends follow-up due/overdue reminders, task deadline reminders, scans for uncontacted / inactive leads and overdue follow-ups (automation triggers), runs the subscription lifecycle (renewal invoice → grace → expiry), records the daily usage snapshot — then sweeps the email outbox.
* `automation.execute` runs one execution (NOTIFY / CREATE_TASK / SET_PRIORITY); results and errors are logged in `automation_executions`; users can retry failed executions from the UI.
* `email.send` delivers one outbox row through the configured provider.
* `JOBS_INLINE=true` runs the same processors in-process (tests/single-process dev); rejected in production.

## Subscriptions & billing
`free` / `starter` / `professional` plans define lead cap, seat cap and feature flags (import/export, automations, custom pipelines & fields, advanced reports, custom roles, rule assignment). Limits are enforced in services (`assertLeadCapacity`, `assertSeatCapacity`, `requireFeature`). Lifecycle: trial → (unpaid) Free · paid period end → renewal invoice + `PAST_DUE` + 7-day grace → `EXPIRED` (read-only) → payment recorded reactivates. Workspace suspension by platform admins blocks all tenant routes.

### Manual billing (`modules/subscriptions/manual-billing.ts`)
* Only the **platform** database role can write `payments` (tenants have read-only RLS, no write grant); triggers `guard_invoice_paid` and `guard_subscription_changes` additionally make the tenant role unable to mark an invoice paid, extend `current_period_end`, activate a paid subscription or upgrade a plan, even through a bug in the API.
* One transaction per confirmation: `SELECT … FOR UPDATE` on the subscription, then payment + receipt number + invoice (settled or generated) + subscription period + `subscription_events` + audit log. Idempotency key and a unique `(reference)` per workspace make double submission harmless; two administrators racing serialize on the lock.
* **Extension policy** (tested in `manual-billing.test.ts`): (1) same paid plan, still running → extend from the **current expiry**, never from today; (2) same plan expired less than the 7-day grace ago → continue from the old expiry; (3) trial still running → paid period starts when the trial would have ended; (4) otherwise (expired beyond grace, canceled, Free→paid, any plan change) → the new period starts at confirmation, no proration. Months are calendar months in the **workspace timezone** (wall-clock preserved across DST; Jan 31 + 1 month = Feb 28/29); a custom extension is a number of days. The preview endpoint returns exactly what a confirmation would write (previous/new expiry, base used).
* Reversal undoes only the **latest** non-reversed payment of a workspace (restores the stored previous period/plan/status/grace), requires a reason, and is itself recorded.
* Plan limits are enforced in services (not only in the UI); expiry/suspension block writes with specific error codes while billing stays reachable; downgrade/expiry never deletes data.

### Automation safety
Actions run in the same transaction as the execution row (all-or-nothing) under a per-execution row lock; actions executed by automation **do not re-trigger automations** (`suppressTriggers`), a per-workspace hourly execution budget (`AUTOMATION_MAX_PER_HOUR`; excess events are dropped with a warning) and rule cap (`AUTOMATION_MAX_RULES`) bound volume, archived leads are skipped, and failed executions count `attempts` and can be retried manually.

## Lead attachments and object storage (`modules/attachments`, `lib/storage.ts`, `lib/file-sniff.ts`)
* **Metadata in PostgreSQL** (`lead_attachments`: name, detected type, size, sha256, uploader, timestamps, soft-delete + `storage_deleted_at`), **bytes in the private object store** under `attachments/<org>/<lead>/<uuid>.<ext>` — never in the database, never a client-chosen name. RLS-forced, composite FK to `leads (id, organization_id)` with `ON DELETE RESTRICT`, key CHECK constraint (`attachments/<own org>/…`, no `..`).
* **Storage adapters** (`ObjectStorage`): S3-compatible (`STORAGE_PROVIDER=s3`; bucket stays private, no signed URL is ever handed out — downloads are streamed through the API after authorisation) and `LocalDiskStorage` for development/tests (path-traversal-proof). In production without S3 the attachment API answers `503 FEATURE_UNAVAILABLE` instead of silently degrading.
* **Validation by content** (`detectAttachment`): magic bytes decide the type (PDF, OLE2 doc/xls, OOXML docx/xlsx by archive entries, JPEG/PNG/WebP, CSV as binary-free non-markup text); the extension must agree with the bytes, the declared MIME must be compatible, executables/scripts/markup/macro-enabled Office files are refused, zip expansion is bounded; the stored extension and content type come from the *detected* type. File names are sanitised for display only (no path parts, control/bidi characters; RFC 5987 `Content-Disposition`).
* **Authorisation on every call**: workspace membership + lead visibility (agents only their own leads) + `leads.update` to upload + uploader-or-`leads.archive` to delete; downloads are `attachment`, `nosniff`, `Content-Security-Policy: sandbox`, `no-store`. Another workspace gets 404; a forged `X-Org-Id` gets 403.
* **Failure and cleanup**: each object is written first and its row second inside the request transaction; if anything fails afterwards the written objects are deleted. Deleting an attachment marks the row, removes the object after commit, and the scheduler's `sweepAttachments` finishes any that failed and deletes **orphans** (objects under `attachments/<org>/` without a row, older than `ATTACHMENT_ORPHAN_GRACE_MS`). Leads are archived, never hard-deleted (`RESTRICT` blocks it); `purgeWorkspaceAttachments(orgId)` must be called before a workspace is ever hard-deleted, because bucket objects do not cascade. Merging leads moves attachments to the surviving lead.
* Limits: `ATTACHMENT_MAX_BYTES`, `ATTACHMENT_MAX_FILES_PER_REQUEST`, `ATTACHMENT_MAX_PER_LEAD`, `ATTACHMENT_WORKSPACE_MAX_BYTES`. Uploads to one lead are serialised by a row lock so the count/quota checks cannot be raced.

## Calendar scheduling (`modules/followups/calendar.ts`, `components/calendar.tsx`)
* One endpoint, `POST /api/calendar/reschedule {kind, id, date[, time] | start, expectedStart?}`. A calendar `date` (and optional `time`) is interpreted **in the workspace timezone** and keeps the item's wall-clock time when no `time` is given — so a move across a daylight-saving change never shifts the hour; the server converts, the browser never decides the instant. Past dates, impossible dates (`2027-02-30`) and > 5 years ahead are rejected.
* Permission: `followups.manage` / `tasks.manage` **and** (assignee or `*.view_all`); only pending follow-ups and open tasks with a due date move; completed/canceled/undated → `409 NOT_RESCHEDULABLE`. The row is locked (`FOR UPDATE`); `expectedStart` makes stale or double drops fail with `409 STALE_EVENT` (one history entry), dropping where it already is is a no-op.
* Side effects reuse the normal rules: follow-ups get the history event, timeline entry and `rescheduleCount`; reminder / overdue flags are cleared for both kinds so the scheduler re-arms them; a task moved to the future is no longer overdue; the assignee is notified when someone else moves it; tasks are audited.
* UI: the calendar renders in the workspace timezone; mouse drag (HTML5), touch long-press (pointer events), Alt+arrows on a focused item, and a **Reschedule** button/dialog as the non-drag alternative; optimistic update with rollback, an Undo action, a live-region announcement.

## Background imports (`modules/leads/import-jobs.ts`)
* **Flow**: upload (validated by content; streamed analysis of header, column mapping, row count ≤ `IMPORT_MAX_ROWS`, first 10 rows validated) → `import_jobs` row in `PREVIEW`, file in private storage (`imports/<org>/<job>.<ext>`) → **start** (`QUEUED`, BullMQ `import.process`, idempotent job id) → worker streams the file (Papa Parse node stream / ExcelJS streaming reader — rows are never all in memory) and commits **batches** of `IMPORT_BATCH_SIZE` (500) rows.
* **One batch = one transaction**: validated leads, tags, sources, assignments, timeline entries, error rows, and the checkpoint (`last_row`) + counters are written together under a `FOR UPDATE` lock on the job row. A crash, a BullMQ retry, a stalled-job re-run or two workers at once therefore resume after the last committed batch and can **never create a lead twice** (tested, including concurrent re-runs).
* **Partial-success policy** (documented in the UI): valid rows are imported; invalid rows and duplicates are skipped and listed (row number, field, reason, original values; CSV download; stored errors capped at `IMPORT_ERROR_CAP`). Committed batches are never rolled back by a later failure or cancellation; the result states exactly how many leads were created. Duplicate rules are the CRM's (normalised e-mail/phone vs existing and within the file); custom fields use the same validation as the API; automations fire for the first 200 leads only.
* **Limits and protection**: plan lead limit enforced per batch (the job stops with `stop_reason=PLAN_LIMIT`, the rest reported as skipped); 1 active import per workspace (`IMPORT_MAX_ACTIVE_PER_ORG`), `IMPORT_MAX_CONCURRENT` running cluster-wide (Redis slots; other jobs re-queue with a delay); max file `IMPORT_MAX_FILE_BYTES`; attempts `IMPORT_MAX_ATTEMPTS` then `FAILED`; suspended workspace / expired subscription / removed creator stop the job.
* **Cancellation**: `PREVIEW`/`QUEUED` immediately; `RUNNING` sets a flag checked before every batch. **Cleanup**: the file is deleted when the job ends; unstarted previews expire after `IMPORT_PREVIEW_TTL_HOURS`; history is kept `IMPORT_HISTORY_DAYS`; lost queue entries are re-dispatched by the scheduler.
* The synchronous `POST /api/leads/import` stays for API clients (≤ 5,000 rows, all-or-nothing per request).

## Search (`modules/leads/queries.ts`, migration `lead_search`)
See [docs/SEARCH_BENCHMARKS.md](docs/SEARCH_BENCHMARKS.md) for the investigation, plans and measurements. In short: under RLS the app role cannot use trigram/full-text indexes (non-leakproof operators), so selective searches run through `lf_search_lead_ids()` — a `SECURITY DEFINER` function owned by the `NOLOGIN` role `leadflow_search` (column-level `SELECT`, isolation by `app_org_id()` inside the function, `EXECUTE` only for the app role) — and the list query becomes `id IN (…)`; broad searches keep the `ILIKE` predicate. `SEARCH_STRATEGY=ilike` is the rollback switch. Cursor pagination for `sort=createdAt`; the large-workspace total cache is keyed by a per-workspace lead-data version bumped after every committing transaction that wrote to `leads`/`lead_tags` (detected centrally in `db.ts`).

## Metrics (`lib/metrics.ts`)
Prometheus text from a **separate listener** (`METRICS_PORT`, `WORKER_METRICS_PORT`), loopback by default, bearer token mandatory off-loopback (the process refuses to start otherwise). Counters/histograms are updated in memory by the HTTP middleware, the job runner, storage adapters, import batches and search; gauges needing I/O (queue, Redis, workers, DB counts via the platform role, cached 30 s) are computed at scrape time; Prisma's own metrics add query timing and pool gauges. Labels are a closed, low-cardinality set (route *patterns*, status, job, state…); no identifiers or personal data. See [docs/MONITORING.md](docs/MONITORING.md).

## Single sign-on (`modules/sso`, `lib/secrets.ts`, `lib/idp-guard.ts`)
Per-workspace OIDC with `openid-client` (certified RP library): authorization code + PKCE (S256), server-side single-use `state` bound to the browser by an HttpOnly cookie, nonce, issuer/audience/signature/expiry validation. Identity = (issuer, subject) in `sso_identities`; e-mail linking only for **verified** e-mail, **allowed domain** and **active membership** (or explicit JIT with a non-administrative role and a seat check); a conflicting second identity is refused. `sso_connections.client_secret_enc` is AES-256-GCM (`SSO_ENCRYPTION_KEY`, workspace id as AAD); tokens are never stored. SSO-only mode is enforced in the request pipeline (`SSO_REQUIRED` for password sessions, owners excepted); sessions record `auth_method`. Issuer fetches go through an SSRF guard (private/loopback/link-local refused in the socket lookup). Recovery: owner switch-off, platform `POST /platform/organizations/:id/sso/disable`, or SQL. Details: [docs/SSO.md](docs/SSO.md).

## Frontend
* App Router; all workspace pages are client components using TanStack Query. Query keys are namespaced by workspace id (`useT`) so caches never mix tenants; switching workspace clears them.
* The API client sends `X-Org-Id`; auth uses the first-party cookie via the `/api` rewrite.
* Design system in `components/ui`: tokens in `globals.css` (neutral palette, restrained indigo accent, 8px radius), keyboard-accessible Radix primitives, promise-based confirmation dialogs, unsaved-change guards on dialogs/sheets, skeleton loaders and empty states. Tables collapse to stacked cards on phones; the sidebar is a drawer below `lg`.

## Key decisions
| Decision | Rationale |
|---|---|
| Express backend (not Next route handlers) | Keeps domain logic, jobs and tenant middleware independent of the UI framework; independently deployable. |
| One transaction per request with RLS context | Strong isolation guarantees and atomic multi-step business operations with little code. |
| Prisma + hand-written SQL migrations for RLS | Typed access, while policies/roles/constraints stay explicit in reviewable SQL. |
| Email outbox + provider interface | Delivery state is explicit and retried; the dev mailbox keeps development credential-free; production uses SMTP or fails visibly. |
| Redis for coordination only | Rate limits, locks and queues are rebuildable; PostgreSQL stays the single system of record. |
| Manual billing by platform admins | No processor is in scope; nothing is ever shown as paid unless a platform administrator confirms a payment received outside the system; enforced in the database, not only in the API. |
