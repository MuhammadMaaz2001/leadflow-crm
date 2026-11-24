# Development progress

Last verified: 2026-11-24 (product audit → [PRODUCT_AUDIT.md](PRODUCT_AUDIT.md); production-readiness engineering → [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md)). Built from scratch in this repository (no previously shared code was used). Status below reflects what was **actually executed and verified** in this environment (PostgreSQL 16, Redis 7, Node 22, Chromium via Playwright).

## Milestones
- [x] **M0** Environment inspected: empty git repo, Node 22, PostgreSQL 16 and Redis 7 available locally (no Docker)
- [x] **M1** Monorepo, Prisma schema (tenant-aware composite FKs), 3 migrations (RLS, roles/grants, constraints), auth, workspaces, memberships, RBAC, tenant transactions, seed
- [x] **M2** Design system (tokens, shell, sidebar, header, forms, tables, dialogs, sheets, confirm, skeletons, empty states) + responsive layout
- [x] **M3** Core CRM: leads (CRUD, search, filters, sort, pagination, bulk, import/export, duplicates & merge, tags, custom fields, saved views), lookups, pipelines, opportunities (kanban + table)
- [x] **M4** Sales operations: follow-ups, activity timeline, tasks, calendar, notifications, reminders
- [x] **M5** Analytics: dashboard (10 KPIs, 8 charts), 11 reports with CSV/Excel export, team performance
- [x] **M6** Automation engine + BullMQ scheduler, subscriptions/billing/plan limits/lifecycle, platform administration
- [x] **M7** QA: API integration tests, web unit tests, Playwright e2e, production builds, documentation

## Verified results
| Check | Result |
|---|---|
| API integration tests (Vitest + Supertest, real PostgreSQL + Redis, schema recreated from migrations on every run) | **134 / 134 pass** in 12 files (auth, lifecycle, isolation, business, settings, security, database, infrastructure & concurrency, operations, storage, payments, real processes) |
| Web unit tests (Vitest + Testing Library) | **20 / 20 pass** |
| Playwright e2e (Chromium, production web build) | **28 / 28 pass** — acceptance journey, leads, permissions, 11 module specs, roles/workspaces/platform, security (CSP + headers + cookies), responsive |
| TypeScript (strict) `npm run typecheck` | clean for shared, api, web |
| Lint `npm run lint` (ESLint flat config, `--max-warnings=0`) | clean |
| Production build `npm run build` | succeeds (shared → Prisma client → API `tsc` → `next build`, 36 routes); built API runs with `node apps/api/dist/server.js` |
| Migrations | 10 migrations apply cleanly on an empty database (every API test run) and upgrade a populated old-schema database in place (`scripts/migration-compat.sh`) |
| Seed | 2 organizations, 3 platform admins, 76 leads, opportunities, follow-ups, tasks, activities, notifications, invoices, usage history |
| OpenAPI | 155 endpoints documented (`/api/docs` in development, `docs/openapi.json`, `API_DOCUMENTATION.md`) |
| Background jobs | BullMQ worker verified live: minute scheduler created reminder/re-engagement tasks from seeded data; inline mode used by tests |
| Console / network errors | crawled every workspace and platform route as manager, owner and platform admin: no console errors, no failed API calls, no horizontal overflow at 1440px / 390px |

## Product audit & refinement (2026-11-24)
Details, evidence and open risks: **[PRODUCT_AUDIT.md](PRODUCT_AUDIT.md)**. Summary of what changed without altering the architecture:
* **Security**: persisted login lockout (it was silently rolled back), role-grant escalation guard, platform role can no longer read email bodies, CSRF origin guard, idle session timeout, upload content validation, hostile-input handling (400/413 instead of 500), fail-safe production defaults, security headers.
* **Database**: 4 additive migrations — same-organization assignee FKs, stage↔pipeline FK, state check constraints, case-insensitive unique names, FK-supporting and scan indexes. Seed fixed to respect the new constraints.
* **UI/UX**: real error states instead of empty tables, 404/error pages, skip link and page titles, dashboard onboarding checklist and chart empty states, kanban outcome dock (+ fix for a drop-target conflict it introduced), timezone/industry selects, tag picker hydration bug, billing copy.
* **Tests**: +26 API tests (security, database), +3 web tests, +20 Playwright specs (modules, roles); ESLint added.
* **Not done / still open**: see §5 of PRODUCT_AUDIT.md — no real email/payment provider, dependency audit before deploy, load testing, no `script-src` CSP, single-instance scheduler and in-memory rate limits. The product is **not** declared production-ready.

## Production-readiness engineering (2026-11-24) — summary
Full report with evidence, measurements and the **list of launch blockers**: **[PRODUCTION_READINESS.md](PRODUCTION_READINESS.md)**. The product is **not** declared production-ready.
* **Dependencies:** `npm audit` 9 → 0 (vitest 5, npm overrides for Prisma-CLI and exceljs transitive packages, native `bcrypt` replacing `bcryptjs`, nodemailer 10).
* **Security:** nonce-based CSP for the web app (verified violation-free), default-deny API CSP, HSTS/COOP/etc., `__Host-` session cookie, atomic single-use tokens, per-account login/reset limits, tenants can no longer self-mark invoices paid in production, production config validation (`check:config`, refuses to start unsafe), RLS/role verification (`db:verify` + start-up probe), bundle secret scan, log redaction.
* **Distributed runtime:** Redis-backed shared rate limiting with fallback, scheduler lease lock, exactly-once automation execution, retry/backoff/stalled-job handling, lost-job recovery sweeps, graceful shutdown of API and worker (tested with real processes), worker heartbeats.
* **Providers:** email outbox + `EmailProvider` (dev/smtp/none, honest statuses), `ObjectStorage` (db/s3), `PaymentProvider` contract + hardened settlement (no adapter), `payment_events` ledger.
* **Operations:** JSON logs with request ids, slow-query log, error hook, `/api/health/{live,ready}`, `/platform/health` with workers + scheduler, role-level DB timeouts, Dockerfile + deploy templates, DEPLOYMENT / BACKUP_RECOVERY / RUNBOOK documents.
* **Load tests (30k / 100k / 250k leads, shared 4-core VM):** found and fixed: pure-JS bcrypt capping login at ~12/s, linear `count(*)`/dashboard cost (large-workspace result cache). Open: search cost grows with workspace size; throughput on production hardware unmeasured.

## Acceptance workflow (all verified end-to-end by `apps/web/e2e/acceptance.spec.ts`)
1. user registers → 2. verifies email (dev link) → 3. creates workspace → 4. onboarding wizard (details, sources, assignment, invitations) → 5. invited manager & agent join → 6. manager creates a lead (duplicate protection checked) → 7. assigns it → 8. salesperson sees it → 9. logs a call → 10. schedules a follow-up → 11. it appears in the calendar → 12–13. scheduler generates the reminder → 14. follow-up completed with mandatory outcome → 15. opportunity created, moved with drag & drop → 16–17. won → 18. timeline shows every change → 19. dashboard KPIs update → 20. reports reflect the data → 21. a second company cannot access the first company's data (UI and API spoofing) → 22. plan limits are enforced → 23. platform administrator suspends / re-activates the workspace and adjusts its subscription.

## Known limitations
* **No external integrations (by scope)**: no payment processor, no email/SMS/WhatsApp delivery. Emails go to the DB-backed dev mailbox; payments are recorded manually and labelled as such. Notifications are in-app only.
* **Prisma `migrate reset`** refuses to run when invoked by an AI agent (safety guard) — `npm run db:reset` must be run by a human; `npm run db:seed` is idempotent for the demo workspaces and was used instead.
* Saved lead views are stored in the browser (localStorage) per workspace, not on the server.
* CSV/Excel import is synchronous and capped at 2,000 rows per file; exports at 20,000 rows.
* Calendar day/week views are agenda style (no drag-to-reschedule); `datetime-local` inputs use the browser timezone while reports use the workspace timezone.
* The global `users` table has no RLS (needed for login); API code never lists users outside a workspace and the platform DB role cannot read CRM tables. Platform admins deliberately see only aggregate usage for an organization.
* Logos are stored as base64 text (≤ 400 KB) rather than in object storage; no file attachments on leads.
* Not implemented: 2FA/SSO, dark mode, per-field audit diff UI, multi-currency conversion, accessibility audit beyond keyboard/ARIA basics, load testing.
* The scheduler walks workspaces sequentially each minute; very large deployments would shard it.

## Remaining work / next steps
Real email provider + payment processor adapters (interfaces are isolated in `lib/email.ts` and the billing `applyPayment`), server-side saved views, background import for large files, 2FA, object storage for logos/attachments, dark theme, calendar drag-and-drop.
