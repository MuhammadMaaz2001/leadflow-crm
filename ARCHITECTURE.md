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
| Secrets | Passwords bcrypt-hashed; session/reset/verify/invite tokens stored as SHA-256 hashes; lockout after 5 failed logins; DB role passwords come from the environment. |

Tested in `apps/api/test/isolation.test.ts`: IDOR on every entity, header spoofing, cross-tenant foreign keys, raw unscoped queries under RLS, platform role denied on CRM tables, deactivated members, per-role permissions.

## Domain model highlights
* **Leads vs opportunities are separate.** A lead is a person/company; an opportunity is a deal with a pipeline, stage, value and expected close date. One lead → many opportunities. Lead lifecycle status (`NEW → CONTACTED → QUALIFIED → CONVERTED | LOST`) is *derived* from contact activity and opportunity outcomes (`syncLeadFromOpportunities`).
* **Won/Lost are real states**: `opportunities.status`, `won_at`/`lost_at` (check-constrained), `lost_reason_id`, plus `stage_history` rows. Stages have a `kind` (OPEN/WON/LOST).
* **Follow-ups** keep `follow_up_events` (created, rescheduled with from/to, completed, canceled); completion requires an outcome and records who/when. "Overdue" is *derived* (`status = PENDING AND due_at < now`), never stored.
* **Activities** are an append-only timeline written by the same services that make the change.
* **Assignments** are append-only (`lead_assignments` with method MANUAL / BULK / ROUND_ROBIN / RULE / IMPORT / MERGE).

## Background processing (BullMQ)
* `scheduler.tick` (repeatable, every minute) iterates workspaces (`app_list_active_orgs()` returns ids only) and, **inside each tenant's RLS context**: sends follow-up due/overdue reminders, task deadline reminders, scans for "not contacted"/"inactive" leads and overdue follow-ups for automation rules, runs the subscription lifecycle and records usage snapshots. All work is idempotent (notification `dedupe_key`, unique `(rule_id, event_key)` on executions).
* `automation.execute` runs one execution: actions NOTIFY / CREATE_TASK / SET_PRIORITY; results and errors are logged in `automation_executions`; BullMQ retries 3× with backoff and users can retry from the UI.
* `JOBS_INLINE=true` runs the same processors in-process (tests/single-process dev).

## Subscriptions & billing
`free` / `starter` / `professional` plans define lead cap, seat cap and feature flags (import/export, automations, custom pipelines & fields, advanced reports, custom roles, rule assignment). Limits are enforced in services (`assertLeadCapacity`, `assertSeatCapacity`, `requireFeature`). Lifecycle: trial → (unpaid) Free · paid period end → renewal invoice + `PAST_DUE` + 7-day grace → `EXPIRED` (read-only) → payment recorded reactivates. Workspace suspension by platform admins blocks all tenant routes.

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
| Dev mailbox instead of SMTP | No external credentials required; swap `lib/email.ts` for a provider. |
| Manual payment recording | No processor is in scope; nothing is ever shown as paid unless a person records it. |
