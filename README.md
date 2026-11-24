# LeadFlow CRM

A multi-tenant SaaS **lead management CRM** — leads, sales pipeline, opportunities, follow-ups, tasks & calendar, team assignment, automations, reports, subscriptions/billing and a separate platform-administration area. Built from scratch as a modular monolith.

| Layer | Technology |
|---|---|
| Web | Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Radix UI primitives (shadcn-style components) · TanStack Query · React Hook Form + Zod · Recharts · dnd-kit · Lucide |
| API | Node 22 · Express 5 · TypeScript · Zod · Prisma 6 · REST + OpenAPI/Swagger |
| Data | PostgreSQL 16 (shared database, **row-level security**, composite tenant FKs) |
| Jobs | Redis 7 · BullMQ (scheduler tick every minute, automation executions with retries) |
| Tests | Vitest + Supertest (API, real PostgreSQL) · Vitest + Testing Library (web) · Playwright (e2e) |

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

## Payments (no processor, by design)
Billing is an internal system: plans, trials, limits, invoices, grace periods and expiry all work, but **no payment is ever simulated as successful**. An invoice becomes `PAID` only when an authorised person records a payment reference (`MANUAL_DEV` for the workspace owner, `MANUAL_PLATFORM` for a billing admin). The UI labels this clearly as a development / manual mechanism, and the action is audit-logged.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API (tsx watch) + worker + web in parallel |
| `npm run build` | shared → Prisma client → API (`tsc`) → web (`next build`) |
| `npm test` | API integration tests (creates `leadflow_test` DB) + web unit tests |
| `npm run test:e2e` | Playwright acceptance + responsive tests (needs a seeded dev DB) |
| `npm run db:migrate` / `db:seed` / `db:reset` | Prisma migrations, seed, full reset |
| `npm run typecheck` | strict TypeScript for every package |

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
