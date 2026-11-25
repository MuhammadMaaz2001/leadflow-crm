# Deployment guide

Target architecture (all pieces already exist in this repository; nothing here requires new CRM features):

```
 browser ──https──▶ Web (Next.js, stateless, N instances)
                      │  /api/* rewrite (same origin → first-party httpOnly cookie)
                      ▼
                    API (Express, stateless, N instances) ───▶ managed PostgreSQL 16   (row level security, 2 runtime roles)
                      │                                    ├─▶ managed Redis 7          (rate limits, locks, BullMQ)
                      │ enqueue                            └─▶ S3-compatible bucket     (logos; private)
                      ▼
                    Worker (BullMQ, N instances) ── minute scheduler (one tick at a time, Redis lease lock) ──▶ SMTP provider
```

Everything is horizontally scalable: **no process keeps state in memory that matters** (rate limits, scheduler locks and queues live in Redis, sessions in PostgreSQL).

> **Status of this document.** The commands and configuration were written for, and the application was tested against, local PostgreSQL 16 and Redis 7.
> The container files (`Dockerfile`, `deploy/`) and the hosting recipes below were **not executed on a hosting platform** (no Docker daemon or cloud account was available).
> Treat the first staging deploy as part of the verification, and read [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) for what is still open.

## 1. Build artefacts

| Process | Build | Start | Port | Scale |
|---|---|---|---|---|
| Web | `npm run build -w @leadflow/web` (needs `API_URL` at build time) | `npm run start -w @leadflow/web` | 3000 | any |
| API | `npm run build -w @leadflow/api` | `node apps/api/dist/server.js` | 4000 | any |
| Worker | same build as the API | `node apps/api/dist/worker.js` | 4001 (optional health) | ≥ 2 recommended |
| Migrations | – | `npm run db:migrate` (one-off job, owner credentials) | – | exactly once per release |

`Dockerfile` has a target for each (`web`, `api`, `worker`, `migrate`); `deploy/docker-compose.example.yml` shows the topology.
Node **22** is required. `bcrypt` ships prebuilt binaries for linux x64/arm64 (glibc and musl); use `node:22-bookworm-slim` (what the Dockerfile uses) rather than distroless images without libc.

## 2. Suggested hosting (pick equivalents freely)

| Component | Needs | Examples |
|---|---|---|
| Web | Node 22 runtime or Next.js-aware platform | Vercel, Netlify, any container host. Set `API_URL` to the public API URL *at build time*; the browser then only talks to the web origin. |
| API + Worker | **persistent** Node processes (long-lived connections, background jobs; not serverless functions) | Render, Fly.io, Railway, AWS ECS/Fargate, Google Cloud Run (min instances ≥ 1, CPU always allocated for the worker), Kubernetes |
| PostgreSQL | 16+, TLS, PITR backups, `pg_trgm` extension available | RDS, Cloud SQL, Neon, Supabase, Crunchy Bridge |
| Redis | 7+, TLS, `maxmemory-policy noeviction`, persistence optional | Upstash (regular TCP endpoint), Redis Cloud, ElastiCache, Memorystore |
| Object storage | S3 API | AWS S3, Cloudflare R2, Backblaze B2, MinIO |
| Email | SMTP | SES, Postmark, Mailgun, SendGrid, any SMTP relay |

Put the web and API behind HTTPS (the platform's TLS termination is fine). Use **one registrable domain** if possible (`app.example.com` / `api.example.com`):
the session cookie is `__Host-lf_session` (Secure, HttpOnly, SameSite=Lax, Path=/, no Domain), set on the web origin because the browser calls `/api/*` through the web app's rewrite.

## 3. PostgreSQL: roles and migrations

Three database identities are involved. Create the *owner* yourself; the migrations create the other two (without passwords).

| Role | Created by | Used by | Properties |
|---|---|---|---|
| owner (e.g. `leadflow`) | you / the provider | migrations, `db:verify`, seed (dev only) | owns the schema; may be a superuser or a role with `CREATEROLE` |
| `leadflow_app` | migration 2 | API + worker (`APP_DATABASE_URL`) | no BYPASSRLS, no DDL, row level security **applies**; statement timeout 60 s |
| `leadflow_platform` | migration 2 | platform-admin screens (`PLATFORM_DATABASE_URL`) | BYPASSRLS but **no grants on private CRM tables** |

Release procedure:
1. Take a backup/snapshot (see [docs/BACKUP_RECOVERY.md](docs/BACKUP_RECOVERY.md)).
2. Run the migration job with owner credentials, `APP_DB_PASSWORD` and `PLATFORM_DB_PASSWORD` set to the passwords you chose for the two runtime roles:
   `npm run db:migrate` (= `prisma migrate deploy` + role passwords). It is idempotent and safe to retry. Migrations are **additive**; no release so far drops or rewrites data.
3. `npm run db:verify` (owner credentials). It must print *Database security checks passed* — row level security enabled **and forced** on every tenant table, runtime roles not superuser / BYPASSRLS, platform role without SELECT on CRM tables.
4. Deploy API + worker (new code tolerates the old schema for one release: migrations first, code second), then the web app.
5. Smoke test: `GET /api/health/ready` → `{"status":"ok"}`, sign in, create a lead, open `/platform/health` (as platform admin).

Roll back = redeploy the previous image; do **not** roll the database back unless the migration itself was faulty (restore from the pre-release snapshot).

### Connections
Each API instance opens up to `DB_POOL_MAX` (default 20) + `DB_PLATFORM_POOL_MAX` (5) connections; each worker the same. Keep
`instances × 25 < max_connections − headroom`. With PgBouncer use **transaction** pooling and add `?pgbouncer=true` to the URLs (the tenant context is set with
`set_config(..., true)` *inside* each transaction, which is compatible with transaction pooling).

## 4. Redis
`REDIS_URL` with TLS (`rediss://`). Required for: shared rate limiting, scheduler lock, BullMQ. If Redis is unreachable, the API stays up (readiness reports *degraded*;
rate limits fall back to per-process windows) while background jobs wait. Use `maxmemory-policy noeviction` so queue keys are never evicted.

## 5. Environment variables
`deploy/api.env.example` (API and worker) and `deploy/web.env.example` list every variable with placeholders; the full reference with defaults is in
[ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md). Before every deploy run the validator with the real environment:

```bash
NODE_ENV=production npm run check:config      # exits 1 and explains every unsafe/missing setting
```
The API and worker run the same validation at start-up and **refuse to start** in production if it fails (development mailbox, inline jobs, localhost URLs, development passwords,
http origins, unsupported providers, owner credentials in `APP_DATABASE_URL` …). The API also probes the database role it connected with and refuses to start if that role could bypass row level security.

Secrets belong in the platform's secret manager (never in git, images or the web build). The web bundle contains no secrets by construction (`npm run scan:secrets` checks the build output).

## 6. Processes in detail

### API
* Stateless; `GET /api/health/live` (liveness), `GET /api/health/ready` (readiness: PostgreSQL required, Redis → *degraded*; 503 while draining or when PostgreSQL is down; `?strict=true` also requires Redis).
* Structured JSON logs on stdout (`LOG_LEVEL`, request ids, redaction), slow-query log (`SLOW_QUERY_MS=500`), error reporting hook (`ERROR_WEBHOOK_URL` or `setErrorReporter`).
* Graceful shutdown on SIGTERM: readiness flips to 503, HTTP server drains (≤ `SHUTDOWN_TIMEOUT_MS`), then connections close. Give the platform a termination grace period of ≥ 30 s.

### Worker
* Run **at least two** for availability; duplicates are safe: the scheduler tick is guarded by a Redis lease lock (`SCHEDULER_LOCK_MS`, renewed while running, expires if the holder crashes), and every job is idempotent.
* Jobs: `automation.execute`, `email.send`, `scheduler.tick` (every minute; reminders, automation scans, subscription lifecycle, usage snapshots, outbox sweep).
* Retries: 5 attempts with exponential backoff (5 s, 10 s, 20 s, 40 s); stalled jobs are re-queued; final failures stay in the failed set for 14 days and are reported through the error hook.
* Heartbeat in Redis every 10 s (visible in `/platform/health`); optional `WORKER_HEALTH_PORT` for platform health checks.
* Graceful shutdown on SIGTERM: stops taking jobs, lets running ones finish, then exits.

### Web
Stateless Next.js server. A per-request Content-Security-Policy with nonces is produced by `apps/web/src/proxy.ts`; all pages are therefore rendered dynamically.
Set `CSP_UPGRADE_INSECURE_REQUESTS=true` when served over HTTPS.

## 7. Email and payments
* Email: set `EMAIL_TRANSPORT=smtp` plus SMTP variables. Mail is written to an outbox in the same transaction as the business change and delivered by the worker; the true status (`QUEUED/SENT/FAILED/UNDELIVERABLE`) is stored. With `EMAIL_TRANSPORT=none` nothing is pretended: mails are marked `UNDELIVERABLE`. Configure SPF/DKIM/DMARC for the sending domain.
* Payments: no processor is integrated. `PAYMENT_PROVIDER=manual`: a platform **billing admin** confirms payments received outside the system (*Platform → Workspace → Billing*, list at `/platform/invoices`) and chooses the extension (1/3/6/12 months or custom days); tenants can neither mark invoices paid nor extend a subscription in any environment — the API has no such endpoint and DB triggers refuse the write from the tenant role. Only `SUPER_ADMIN` and `BILLING_ADMIN` can record or reverse payments; `SUPPORT_ADMIN` is read-only. Create the first super admin manually (§8) and give billing staff the `BILLING_ADMIN` role. The provider contract and the hardened settlement routine are in `apps/api/src/modules/subscriptions/payment-provider.ts` — an adapter needs real credentials, a webhook route with raw-body signature verification, and its own review before use.

## 8. First-time setup of an environment
1. Provision PostgreSQL, Redis, bucket, SMTP, DNS/TLS.
2. Fill the secret manager from `deploy/api.env.example`; run `npm run check:config`.
3. Run the migration job; run `db:verify`.
4. Create the first platform super admin **manually** (there is intentionally no default admin in production):
   register the account in the UI, verify the email, then as the database owner run
   `UPDATE users SET platform_role = 'SUPER_ADMIN' WHERE email = 'you@example.com';`
   Never run `npm run db:seed` against a production database (it creates accounts with published development passwords).
5. Deploy API, worker(s), web. Check health endpoints and `/platform/health`.

## 9. Operations
See [docs/RUNBOOK.md](docs/RUNBOOK.md) (monitoring signals, alerts, common incidents) and [docs/BACKUP_RECOVERY.md](docs/BACKUP_RECOVERY.md).
