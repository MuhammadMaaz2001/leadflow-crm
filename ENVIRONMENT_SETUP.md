# Environment setup

## Prerequisites
* Node.js ≥ 22 and npm ≥ 10
* PostgreSQL ≥ 15 (developed on 16) with the `pg_trgm` extension available (ships with `postgresql-contrib`)
* Redis ≥ 6 (developed on 7)
* For e2e tests: Chromium (Playwright). On this machine a matching browser is pre-installed; elsewhere run `npx playwright install chromium`.

## 1. Install dependencies
```bash
npm install          # npm workspaces; postinstall runs `prisma generate`
```

## 2. Configure environment variables
```bash
cp .env.example .env
```
| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | – | **Fail-safe**: anything other than `development` or `test` is production (secure `__Host-` cookie, no dev mailbox/links, no `/api/dev/*`, Swagger off). `npm run dev`, `dev:worker`, `seed` set `development` explicitly; do not put it in `.env` (it changes `next build`). Production must say `production` — `check:config` enforces it |
| `DATABASE_URL` | – | Owner/migration connection (migrations, `db:verify`, dev seed). Not used by the running API |
| `APP_DATABASE_URL` | – | Runtime role `leadflow_app` (no superuser, no BYPASSRLS → row level security applies) |
| `PLATFORM_DATABASE_URL` | – | Role `leadflow_platform` (BYPASSRLS but no grants on private CRM tables) |
| `APP_DB_PASSWORD`, `PLATFORM_DB_PASSWORD` | – | Passwords applied to the two roles by `npm run db:migrate` (never stored in migration SQL) |
| `DB_POOL_MAX`, `DB_PLATFORM_POOL_MAX`, `DB_POOL_TIMEOUT_S` | 20, 5, 20 | Prisma pool sizes per process (added to the URLs unless they already set `connection_limit` / `pool_timeout`) |
| `SLOW_QUERY_MS` | 0 (off) | Log statements slower than this (parameterised SQL only, never values). Recommended 500 in production |
| `REDIS_URL` | `redis://localhost:6379` | Rate-limit counters, scheduler lease lock, BullMQ, worker heartbeats |
| `RATE_LIMIT_STORE` | `redis` | `redis` (shared by all instances) or `memory` (per process; falls back automatically while Redis is down) |
| `DISABLE_RATE_LIMIT` | – | `true` disables limiters. Only for `npm run dev:e2e` and load tests; **rejected in production** |
| `TRUST_PROXY` | 1 | Reverse-proxy hops in front of the API (client IP for rate limiting) |
| `JOBS_INLINE` | `false` | `true` runs jobs inside the API process (tests / single-process dev). **Rejected in production** |
| `QUEUE_NAME`, `JOB_BACKOFF_MS` | `leadflow`, 5000 | BullMQ queue name and base retry backoff (tests override them) |
| `WORKER_CONCURRENCY`, `WORKER_HEALTH_PORT` | 5, – | Jobs processed in parallel per worker; optional HTTP health endpoint (`/health`) |
| `SCHEDULER_LOCK_MS` | 120000 | Lease of the scheduler lock (renewed while a tick runs; expires if the holder crashes) |
| `SHUTDOWN_TIMEOUT_MS` | 25000 | Upper bound for graceful shutdown on SIGTERM |
| `API_PORT`, `API_URL`, `WEB_URL` | 4000, … | Ports/URLs. `WEB_URL` may be a comma-separated list of browser origins (CORS + CSRF origin check; https only in production). The web app proxies `/api/*` to `API_URL` (build-time) so cookies are first-party |
| `SESSION_COOKIE_NAME`, `SESSION_TTL_DAYS`, `SESSION_IDLE_DAYS` | `lf_session` (`__Host-lf_session` in production), 14, 7 | httpOnly session cookie; sessions also expire after `SESSION_IDLE_DAYS` without use |
| `LOG_LEVEL`, `ACCESS_LOG`, `SERVICE_NAME` | `info`, `true`, `leadflow-api` | JSON logging; one access-log line per request with request id |
| `ERROR_WEBHOOK_URL` | – | Optional https endpoint that receives redacted JSON error events (5xx and failed jobs) |
| `API_DOCS` | off in production | Serve Swagger UI and `/api/openapi.json` |
| `ALLOW_DEV_TOOLS` | – | `false` disables the dev mailbox/dev links even when `NODE_ENV=development`. `true` is rejected in production |
| `EMAIL_TRANSPORT` | `dev` | `dev` (database mailbox, never delivered) · `smtp` · `none` (everything marked UNDELIVERABLE). Production requires `smtp` (or knowingly `none`) |
| `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` | – , 587 | SMTP settings (STARTTLS enforced in production unless `SMTP_SECURE=true`) |
| `STORAGE_PROVIDER` | `db` | `db` (logos inline in PostgreSQL) or `s3` |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | – | S3-compatible object storage (private bucket) |
| `PAYMENT_PROVIDER` | `manual` | Only `manual` exists. Any other value is rejected |
| `CSP_UPGRADE_INSECURE_REQUESTS` | – | Web: add `upgrade-insecure-requests` to the CSP when served over https |

`NODE_ENV=production npm run check:config` validates a real environment against the production rules; the API and worker run it at start-up.

In production use strong, unique passwords, TLS, `NODE_ENV=production`, and keep all of these in a secret manager.

## 3. PostgreSQL
Create the database and an owner role (example for a local server):
```bash
sudo -u postgres psql -c "CREATE ROLE leadflow LOGIN SUPERUSER PASSWORD 'leadflow_dev'"
sudo -u postgres createdb -O leadflow leadflow
```
(`SUPERUSER` is only needed so the migration can create the `BYPASSRLS` platform role and the extension; a managed service can run that one migration with an admin account.)

On Debian/Ubuntu: `sudo pg_ctlcluster 16 main start`. With Docker: `docker run -p 5432:5432 -e POSTGRES_PASSWORD=… postgres:16`.

## 4. Redis
```bash
redis-server --daemonize yes      # or: docker run -p 6379:6379 redis:7
```

## 5. Migrate and seed
```bash
npm run db:migrate    # prisma migrate deploy + role passwords
npm run db:seed       # demo data (see README for the credentials)
npm run db:reset      # drop everything, re-migrate and re-seed
```
Migrations (`packages/database/prisma/migrations`):
1. `…_init` — tables, enums, indexes, composite tenant FKs (generated by Prisma)
2. `…_rls_roles_constraints` — RLS policies, DB roles & grants, check constraints, partial/trigram indexes, `platform_org_overview` view
3. `…_invitation_preview` — SECURITY DEFINER function for the public invite page

## 6. Run
```bash
npm run dev                       # api + worker + web
# or individually
npm run dev -w @leadflow/api      # http://localhost:4000  (Swagger: /api/docs)
npm run dev:worker -w @leadflow/api   # BullMQ worker + minute scheduler
npm run dev -w @leadflow/web      # http://localhost:3000
```
If you do not run the worker, set `JOBS_INLINE=true` — automation executions run in the request process, but the periodic scheduler (reminders, overdue alerts, inactivity scans, subscription lifecycle) only runs in the worker (or via `POST /api/dev/scheduler/tick` in development).

## 7. Tests
```bash
npm test -w @leadflow/api         # creates/drops DB `leadflow_test` automatically (needs DB owner privileges)
npm test -w @leadflow/web         # component/unit tests
npm run test:e2e                  # starts API (dev mode) + production web build if not running; needs migrated+seeded dev DB
```

## 8. Production build
See [DEPLOYMENT.md](DEPLOYMENT.md) for the full deployment guide (hosting, roles, migrations, Docker, first-time setup).

```bash
npm run build
NODE_ENV=production node apps/api/dist/server.js     # API
NODE_ENV=production node apps/api/dist/worker.js     # worker (run two or more: a Redis lease lock makes the scheduler single-flight)
npm run start -w @leadflow/web                       # web
```
Set `API_URL` (build-time rewrite target for the web app) and `WEB_URL` (CORS origin) appropriately. Run migrations with `npm run db:migrate` before starting the new version.
