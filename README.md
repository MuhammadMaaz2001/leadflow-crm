# LeadFlow CRM

A multi-tenant SaaS **lead management CRM** — leads, sales pipeline, opportunities, follow-ups, tasks & calendar, team assignment, automations, reports, subscriptions/billing and a separate platform-administration area. Built from scratch as a modular monolith.

| Layer | Technology |
|---|---|
| Web | Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Radix UI primitives (shadcn-style components) · TanStack Query · React Hook Form + Zod · Recharts · dnd-kit · Lucide |
| API | Node 22 · Express 5 · TypeScript · Zod · Prisma 6 · REST + OpenAPI/Swagger |
| Data | PostgreSQL 16 (shared database, **row-level security**, composite tenant FKs) |
| Jobs & coordination | Redis 7 · BullMQ (minute scheduler guarded by a distributed lock, automation executions, email outbox; retries with backoff) · Redis-backed rate limiting shared by all API instances |
| Tests | Vitest + Supertest (API, real PostgreSQL) · Vitest + Testing Library (web) · Playwright (e2e) |

> Production: [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) (what is verified and what is still open) · [DEPLOYMENT.md](DEPLOYMENT.md) · [docs/BACKUP_RECOVERY.md](docs/BACKUP_RECOVERY.md) · [docs/RUNBOOK.md](docs/RUNBOOK.md)

> Documentation index: [ARCHITECTURE.md](ARCHITECTURE.md) · [DATABASE_DESIGN.md](DATABASE_DESIGN.md) · [API_DOCUMENTATION.md](API_DOCUMENTATION.md) · [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md) · [docs/REPORTING_DEFINITIONS.md](docs/REPORTING_DEFINITIONS.md) · [DEVELOPMENT_PROGRESS.md](DEVELOPMENT_PROGRESS.md)

## Quick start

```bash
cp .env.example .env                 # development values only
npm install                          # installs all workspaces + generates the Prisma client
# PostgreSQL 16 and Redis must be running (see ENVIRONMENT_SETUP.md)
npm run db:migrate                   # applies migrations, creates the restricted DB roles
npm run db:seed                      # demo data (2 workspaces, platform admins)
npm run dev                          # API :4000 · worker · web :3000
```

Open <http://localhost:3000> · API docs (Swagger UI) <http://localhost:4000/api/docs> · dev mailbox <http://localhost:3000/dev/mailbox>

## Development credentials (**development only — never use in production**)

| Role | Email | Password |
|---|---|---|
| Platform **Super Admin** | `admin@leadflow.test` | `Admin#Pass2026` |
| Platform Support Admin | `support@leadflow.test` | `Admin#Pass2026` |
| Platform Billing Admin | `billing@leadflow.test` | `Admin#Pass2026` |
| **Northwind Realty** (Professional) — Owner | `owner@northwind.test` | `Demo#Pass2026` |
| Northwind — Manager *(also a Sales Agent in Brightpath → multi-workspace demo)* | `manager@northwind.test` | `Demo#Pass2026` |
| Northwind — Sales agents | `sara@northwind.test`, `diego@northwind.test`, `hannah@northwind.test` | `Demo#Pass2026` |
| **Brightpath Digital** (Starter) — Owner | `owner@brightpath.test` | `Demo#Pass2026` |
| Brightpath — Manager | `manager@brightpath.test` | `Demo#Pass2026` |
| Brightpath — Sales agents | `lena@brightpath.test`, `jamal@brightpath.test` | `Demo#Pass2026` |

The seed creates 42 + 34 realistic leads, opportunities across all stages, follow-ups (overdue / today / upcoming / completed), tasks, activities, notifications, invoices and usage history. Re-running `npm run db:seed` resets the two demo workspaces.

## Email verification in development
There is no email provider. Every outgoing email (verification, invitation, password reset) is stored in `outbound_emails` and shown at **/dev/mailbox**; the registration screen also shows a "Verify my email now" link. In production (`NODE_ENV=production`) the mailbox, dev links and the dev scheduler endpoint are disabled.

## Payments — manual billing only (no payment processor, by design)
Plans, trials, limits, invoices, grace periods and expiry all work, but **no payment is ever simulated as successful and no online gateway is integrated**.
A **platform billing administrator** (`SUPER_ADMIN` / `BILLING_ADMIN`) records a payment that was received *outside* the system (bank transfer, cash, cheque, …) under
*Platform → Workspace → Billing*: they pick the plan and the extension (**1 / 3 / 6 / 12 months or a custom number of days**), see the **previous and new expiry** in a preview, add a
reference and notes, and confirm. Subscription, invoice, receipt, history and audit entry are written in **one transaction** (row lock + idempotency key + unique reference),
the latest payment can be reversed with a reason, and every payment/extension is listed in the workspace's history. Workspace owners can *see* invoices, receipts and their
expiry but **cannot mark anything paid or extend** — the API has no such endpoint and database triggers refuse it from the tenant role. The extension policy is in
[ARCHITECTURE.md](ARCHITECTURE.md#subscriptions--billing); procedures are in [docs/RUNBOOK.md](docs/RUNBOOK.md#manual-billing).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API (tsx watch) + worker + web in parallel |
| `npm run build` | shared → Prisma client → API (`tsc`) → web (`next build`) |
| `npm test` | API integration tests (creates `leadflow_test` DB) + web unit tests |
| `npm run test:e2e` | Playwright acceptance, module, role and responsive tests against the production web build (needs a seeded dev DB; creates throw-away workspaces) |
| `npm run db:migrate` / `db:seed` / `db:reset` | Prisma migrations, seed, full reset |
| `npm run typecheck` | strict TypeScript for every package |
| `npm run lint` | ESLint (flat config, zero warnings allowed) |
| `npm run check:config` | Validates the environment against the production rules (`NODE_ENV=production npm run check:config`) |
| `npm run db:verify` | Checks a live database: RLS enabled+forced everywhere, runtime roles least-privilege, no unfinished migrations |
| `npm run scan:secrets` | Scans the built browser bundles for secrets (run after `npm run build`) |
| `scripts/loadtest-db.sh`, `src/scripts/loadtest/*` | Load-test database, bulk data generator, scenario runner and EXPLAIN tool (see PRODUCTION_READINESS.md) |
| `npm run dev:e2e -w @leadflow/api` | API with rate limits disabled, as used by Playwright |

## Repository layout
```
apps/api        Express API — one folder per business domain under src/modules
apps/web        Next.js app — (auth) routes, onboarding, (app) workspace shell, /platform admin area
packages/database  Prisma schema, SQL migrations (RLS, roles, constraints), generated client
packages/shared    Zod schemas, permission catalogue, constants shared by API and web
docs            Reporting definitions
```

## Feature map
Authentication & workspaces · dashboard & analytics · lead management (CRUD, search, filters, bulk, CSV/Excel import & export, duplicate detection & merge, tags, custom fields, assignment history) · pipeline & opportunities (kanban + table, drag & drop, custom pipelines/stages, stage history, lost reasons) · follow-ups (schedule / complete with outcome / reschedule / cancel / calendar / reminders) · team & assignment (manual, bulk, round-robin, rule-based) · activity timeline · tasks & calendar · 11 reports with CSV/Excel export · notifications & automation engine (BullMQ) · workspace settings · SaaS billing & plan limits · platform administration.

See [DEVELOPMENT_PROGRESS.md](DEVELOPMENT_PROGRESS.md) for the verified status, test results and known limitations.

## Test results (last run in this environment)
`npm test` → API 51/51 · web 13/13 · `npm run test:e2e` → 6/6 · `npm run build` ✔ · `npm run typecheck` ✔. Details and known limitations: [DEVELOPMENT_PROGRESS.md](DEVELOPMENT_PROGRESS.md).
