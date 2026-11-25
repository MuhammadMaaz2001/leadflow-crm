# Backup and recovery

What must survive a disaster, and how to get it back. **None of the restore procedures below has been executed against a managed
production service from this repository** — the commands were exercised only against local PostgreSQL / Redis (see "What was tested").
Run a restore drill in a staging environment before launch and after every major change.

## What holds state

| Component | Contents | Loss impact | Backup |
|---|---|---|---|
| **PostgreSQL** | everything: workspaces, leads, history, billing (**payments, receipts, invoices, subscription history — the only record of manually confirmed payments**), saved views, audit logs, sessions, email outbox, logos (when `STORAGE_PROVIDER=db`) | total | **required** — continuous (PITR) + daily logical dump |
| **Object storage (S3)** | workspace logos (`logos/<org>/<hash>.<ext>`) | cosmetic: the logo disappears, re-upload fixes it | bucket versioning (+ optional cross-region replication) |
| **Redis** | rate-limit counters, scheduler/lock keys, BullMQ queue, worker heartbeats | **recoverable by design** — see below | persistence optional (`appendonly yes` recommended) |
| Next.js / API containers | none (stateless) | none | rebuild from git tag |

### Redis loss is a non-event
Redis holds no system of record. If it is flushed or replaced: rate-limit counters restart; the scheduler lock simply expires; the minute
scheduler is re-registered by the worker at start-up (`upsertJobScheduler` is idempotent); automation executions that were queued but not yet
run stay `PENDING` in PostgreSQL and the scheduler re-queues anything older than 5 minutes (`requeueStuckExecutions`); emails that were
queued but not sent stay `QUEUED`/`FAILED` in `outbound_emails` and are re-queued by `sweepEmailOutbox`. Both paths are covered by tests
(`apps/api/test/infra.test.ts`).

## PostgreSQL

### Targets (agree them with the business — these are suggestions, not measurements)
* **RPO** ≤ 5 minutes (managed PITR / WAL archiving), **RTO** ≤ 1 hour (restore to a new instance + redeploy).

### Backups
1. **Managed point-in-time recovery** (RDS, Cloud SQL, Neon, Supabase, Crunchy …): enable automated backups with ≥ 14 days retention and WAL archiving.
2. **Daily logical dump** to a *different* account/region, encrypted, retention ≥ 30 days:
   ```bash
   pg_dump --format=custom --no-owner --no-privileges --file leadflow-$(date +%F).dump "$DATABASE_URL"
   ```
   Use the **owner** connection string (the runtime roles cannot read every table). Encrypt before upload (`age`, `gpg` or the provider's KMS).
3. **Roles are not part of a database dump.** Keep `leadflow_app` and `leadflow_platform` definitions reproducible: they are created by the migrations; only their
   passwords are set out of band (`npm run db:migrate` runs `set-role-passwords`).

### Restore procedure
1. Provision an empty PostgreSQL 16 instance (never restore over the live one).
2. Create the database and restore:
   ```bash
   createdb leadflow
   pg_restore --no-owner --no-privileges --dbname "$NEW_OWNER_URL" leadflow-YYYY-MM-DD.dump
   ```
   (For managed PITR use the provider's "restore to point in time" into a new instance instead.)
3. Re-apply role passwords and any pending migrations: `DATABASE_URL=$NEW_OWNER_URL npm run db:migrate` (idempotent).
4. **Verify the security posture before routing traffic:** `DATABASE_URL=$NEW_OWNER_URL npm run db:verify` must print *Database security checks passed*
   (row level security enabled and forced on every tenant table, runtime roles least-privilege).
5. Point `APP_DATABASE_URL` / `PLATFORM_DATABASE_URL` of API and worker to the new instance and deploy; check `GET /api/health/ready` and `/platform/health`.
6. Sessions survive the restore (they are rows); users whose session was created after the backup must sign in again.
7. After a PITR restore to *before* an incident, the email outbox may contain rows that were already delivered after the restore point: the `sent_at` / provider message ids
   are lost for those rows and `QUEUED` rows will be sent again by the sweeper. If that matters (duplicate invitation emails), mark old `QUEUED` rows `UNDELIVERABLE` before starting the worker.

### Partial recovery (a single workspace / accidental deletion)
Restore into a scratch database (step 2), then copy the affected rows with `INSERT … SELECT` using the owner connection (it bypasses row level security).
Leads are soft-deleted (`archived_at`) and merges are reversible only from history, so most "I deleted it" cases need no restore: use *Archived* filter → *Restore*.

## Object storage
* Enable **versioning** and a lifecycle rule for non-current versions (30 days).
* Logos are content-addressed (`<sha256-prefix>.<ext>`); losing the bucket only blanks logos. `organizations.logo_data` keeps `storage:<key>`; re-uploading replaces it.

## What was tested here
* Migrations apply cleanly on an **empty database** — every API test run recreates `leadflow_test` from migrations; the full migration chain also upgrades an existing development database in place (`migrate deploy`).
* `db:verify` passes on the migrated schema and fails on a table without RLS (tested).
* Redis-loss recovery paths: tested (see above).
* **Not tested:** `pg_dump`/`pg_restore` round trip of a populated database on a managed provider, PITR, S3 versioning restore, cross-region failover.

## Manual-billing records
Because payments are confirmed by hand and there is no payment processor to re-query, the `payments`, `invoices`, `subscription_events` and `audit_logs` tables are the **only** record of what a customer has paid. After any restore: run `npm run db:verify`, then compare the latest `payments` rows with the finance ledger (bank statement/cash book) for the period between the backup and the incident, and re-enter any confirmation that was lost (each needs a new reference or idempotency key). Never recreate payments by editing rows directly — the tenant role cannot, and the platform role should use the billing screen so the receipt, invoice and history stay consistent.
