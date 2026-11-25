# Operations runbook

## Signals to watch
| Signal | Where | Healthy | Alert when |
|---|---|---|---|
| Readiness | `GET /api/health/ready` (per instance) | 200 `ok` | 503 for > 1 min (database down) · `degraded` for > 5 min (Redis down) |
| Liveness | `GET /api/health/live` | 200 | no answer |
| Worker presence & scheduler age | `/platform/health` (platform admin UI) → *workers*, *scheduler* | ≥ 1 worker, last tick < 3 min | 0 workers, or scheduler stale > 3 min |
| Queue | `/platform/health` → *queue* counts | `failed` stays small | `failed` growing, `waiting` growing for > 10 min |
| Error rate | logs: `level=error`, `msg="request"` with `status>=500`; `ERROR_WEBHOOK_URL` | ~0 | > 1 % of requests 5xx for 5 min |
| Latency | access log `durationMs` (one line per request, `requestId` correlated) | see load-test results | p95 doubles vs baseline |
| Slow queries | logs: `msg="slow query"` (`SLOW_QUERY_MS`) | rare | sustained |
| Rate limiting | responses `429` / header `RateLimit-*` | rare | spikes from a single IP / account (credential stuffing) |
| Email | `outbound_emails.status` | `SENT` | `FAILED` / `UNDELIVERABLE` rows older than 15 min |
| Database | provider metrics | connections < 80 % of `max_connections`; replication/backup OK | connection exhaustion, long-running transactions (`idle_in_transaction_session_timeout` is 120 s) |

Every log line is JSON with `time, level, msg, requestId, service` (+ `userId`, `orgId` when authenticated). A user reporting an error gets the `requestId` in the 500 response body — search logs for it.

## Common incidents
**API instances flapping / 503 readiness** — database unreachable or connection limit hit. Check `max_connections` against `instances × (DB_POOL_MAX + DB_PLATFORM_POOL_MAX)`; reduce pools or add PgBouncer. The API refuses to start with invalid configuration: read the first `config:` error lines in the log.

**Emails not arriving** — `SELECT status, last_error, count(*) FROM outbound_emails WHERE created_at > now() - interval '1 day' GROUP BY 1,2;` `UNDELIVERABLE` → `EMAIL_TRANSPORT` is `none`. `FAILED` → provider error text is in `last_error`; fix credentials, the sweeper retries automatically (≤ 20 attempts).

**Reminders / automations stopped** — `/platform/health`: no worker or stale scheduler. Start a worker. After a Redis flush nothing needs manual repair: the worker re-registers the schedule at start, pending automation executions and unsent emails are re-queued by the scheduler.

**Failed background jobs** — they stay in the BullMQ failed set for 14 days. Automation executions have their own *Retry* action in the UI (Automations → Executions). Fix the cause first; a job that fails 5 times is reported through `ERROR_WEBHOOK_URL`.

**A workspace is slow** — look for `slow query` lines with that workspace's `orgId` (request logs carry it), run `EXPLAIN (ANALYZE, BUFFERS)` as the owner role with `SET app.org_id = '<uuid>'`. Know that `ILIKE '%term%'` search cannot use the trigram index under row level security (see PRODUCTION_READINESS.md) — it scans the workspace's rows via the tenant index.

**Suspected credential stuffing** — `429 RATE_LIMITED` bursts on `/api/auth/login`; accounts lock for 15 min after 5 failures. Block the source at the edge/WAF; limits are enforced across instances through Redis.

**Redis outage** — API continues (readiness `degraded`), rate limits become per-process, scheduler/jobs pause. Restore Redis; no data repair needed.

**Database failover / restore** — see [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md). After any restore run `npm run db:verify`.

**Leaked secret** — rotate in the secret manager and redeploy. Rotate DB role passwords by changing `APP_DB_PASSWORD`/`PLATFORM_DB_PASSWORD`, re-running `npm run db:migrate`, then updating the connection URLs; sessions stay valid. Revoke all sessions: `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;`.

## Lead attachments and imports
* **Uploads fail with `STORAGE_UNAVAILABLE`/`FEATURE_UNAVAILABLE`** — `leadflow_storage_operations_total{result="error"}`, bucket credentials/network, `STORAGE_PROVIDER=s3` missing in production. Nothing is saved on failure; users can retry.
* **A downloaded file is missing (`FILE_MISSING`)** — the row exists but the object does not (bucket restore/lifecycle). Re-upload; see BACKUP_RECOVERY.md → Attachments: consistency.
* **Disk/bucket growing** — `SELECT organization_id, count(*), sum(size_bytes) FROM lead_attachments WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 3 DESC` (as the owner role). The per-workspace cap is `ATTACHMENT_WORKSPACE_MAX_BYTES`.
* **Removing a workspace permanently** — call `purgeWorkspaceAttachments(orgId)` (apps/api/src/modules/attachments/service.ts) **before** deleting the organisation row; bucket objects do not cascade.
* **An import is stuck in QUEUED** — is a worker running (`leadflow_workers_alive`)? The scheduler re-dispatches jobs queued > 2 min or running without progress > 10 min. All concurrency slots busy (`IMPORT_MAX_CONCURRENT`) makes it wait with a 15 s delay. Cancel it from the import dialog (History) if needed.
* **An import FAILED** — `SELECT status, error, attempts, last_row, processed_rows, created_rows FROM import_jobs WHERE id = '…'`. Committed batches are kept; fix the cause (storage, plan, subscription) and import the remaining rows again (the duplicate rule skips what already exists). The row-level reasons are in the error report (`/leads/import/jobs/:id/errors`).
* **Imports are slow right after loading a fresh/empty database** — PostgreSQL plans foreign-key checks with statistics of an empty table until autovacuum analyses it (measured 400 rows/s cold vs 1,200–1,900 rows/s warm). Run `ANALYZE leads, lead_tags, activities;` as the owner after a bulk load.

## Search
* **Rollback** — set `SEARCH_STRATEGY=ilike` and restart the API: the previous ILIKE-only behaviour (slow for rare terms in very large workspaces, otherwise identical results).
* **Verify the optimisation** — `npm run db:verify` (function owner/privileges), then as the owner role `SET LOCAL ROLE leadflow_search; SELECT set_config('app.org_id','<org>',true); EXPLAIN ANALYZE SELECT id FROM leads WHERE organization_id='<org>' AND email ILIKE '%rare%';` should show `Bitmap Index Scan on leads_email_trgm`.
* **A search is slow** — broad terms (thousands of matches) are limited by their `count(*)` under RLS (see docs/SEARCH_BENCHMARKS.md §5); check `leadflow_lead_search_total{strategy="broad"}`; for large workspaces the result cache (`LARGE_WORKSPACE_LEADS`) helps repeated queries.

## Metrics and alerts
Alert → first action: `LeadFlowNoWorker`/`LeadFlowSchedulerStale` → start/inspect the worker (see "Reminders / automations stopped"); `LeadFlowHighErrorRate` → logs by `requestId`, `leadflow_http_errors_total` by route; `LeadFlowQueueBacklog`/`FailedJobsGrowing` → worker capacity, failed jobs in `/platform/health`; `LeadFlowDbPoolSaturated` → pool sizes / PgBouncer; `LeadFlowStorageFailures` → bucket; `LeadFlowRedisDown` → Redis. Scrape returns 401: token mismatch; no scrape: `METRICS_PORT` unset or network policy.

## Single sign-on
* **Members cannot sign in / the IdP is down** — an **owner** can always use a password: Settings → Single sign-on → *Switch SSO off* (or *Remove*). If no owner can: a platform administrator calls `POST /api/platform/organizations/:id/sso/disable {reason}`; last resort SQL in docs/SSO.md.
* **Error codes** (login page / Settings → Status): `TOKEN_INVALID` (signature/issuer/audience/nonce/expiry — check the provider's clock and the configured issuer/client id), `IDP_REJECTED` (code/PKCE/secret rejected — wrong or rotated client secret), `EMAIL_NOT_VERIFIED`, `DOMAIN_NOT_ALLOWED`, `NO_ACCOUNT` (invite the person or enable JIT), `NOT_A_MEMBER`, `IDENTITY_MISMATCH` (unlink the member under Linked members), `SEAT_LIMIT_REACHED`, `SSO_SECRET_UNREADABLE` (encryption key changed: re-enter the secret). Every failure is in the audit log (`sso.login_failed`, with the reason and no tokens).
* **After changing the issuer, client id, secret or scopes** SSO is switched off until a new test sign-in succeeds (by design).

## Manual billing
Who: platform `SUPER_ADMIN` or `BILLING_ADMIN` (*Platform → Organizations → workspace → Billing*; all payments at *Platform → Invoices*). Nothing is ever paid or extended automatically.
* **Confirm a payment**: verify the money arrived (bank statement/cash book) → choose plan and extension (1/3/6/12 months or custom days) → check the preview (*previous expiry → new expiry*, base used) → enter the **payment reference** and amount received → confirm. A repeated submission with the same reference/idempotency key is rejected, not applied twice.
* **Amount differs from the invoice**: the form refuses it unless "allow amount mismatch" is ticked and explained in the note.
* **Extend without payment** (goodwill/support): the separate *Extend* action (reason required); it is audited and appears in the history as such.
* **Mistaken entry**: *Reverse* the **latest** payment with a reason (restores the previous plan/period/status). Only the most recent payment can be reversed, and only while the subscription has not been changed since (otherwise the API answers `NOT_REVERSIBLE`: record a correction instead).
* **Customer says they paid but nothing changed**: look up the reference in *Platform → Invoices → Payments*; if absent, the payment was never confirmed. Owners can only see invoices, receipts and expiry.
* **Audit**: every confirmation/reversal writes `subscription_events` (workspace history) and an audit log entry with the administrator.
* **Expiry**: running → `PAST_DUE` with a 7-day grace (full access) → `EXPIRED` (read-only, billing reachable) → a confirmed payment restores access. No data is deleted at any stage.

## Handing over a team member's work
Deactivating or removing a member opens *Hand over work*: choose a successor for their open leads, deals, follow-ups and tasks, or explicitly release leads/tasks/deals to nobody (follow-ups then come to you). The operation is one transaction; assignment history records it. Nothing is orphaned silently.

## Routine tasks
* Weekly: review failed jobs, `outbound_emails` failures, `npm audit` (CI should run it), database growth (`activities`, `audit_logs`, `notifications` are append-heavy).
* Monthly: restore drill from the latest logical dump into staging + `npm run db:verify`.
* Per release: backup → migrate → `db:verify` → deploy → smoke test (see DEPLOYMENT.md §3).
