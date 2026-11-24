# Product audit — LeadFlow CRM

Audit date: 2026-11-24. Scope: UI/UX, functional behaviour, security, database, SaaS/role behaviour and a final verification pass, performed **without changing the architecture** (same monorepo, same request pipeline, same tenant-isolation model). Everything listed as "verified" was executed in this environment; items that were not verified are listed under [Not verified / accepted risks](#not-verified--accepted-risks).

> **This document does not declare the product production-ready.** It records what was tested, what was fixed and what is still open. See the last section before deploying.

## 1. Method

| Area | How it was audited |
|---|---|
| UI/UX | Playwright (Chromium) against the **production** web build: every route as owner / manager / agent / viewer / platform admin, desktop 1440 px, tablet and phone viewports, screenshots reviewed, forms/tables/dialogs/menus driven with real clicks and typing, console and `pageerror` output logged per test |
| Functional | UI-driven end-to-end tests for each module (leads, lead detail, follow-ups, tasks & calendar, opportunities, kanban drag & drop, billing, team, settings, viewer restrictions, platform admin) plus API integration tests against a real PostgreSQL |
| Security | Attack-style API tests (CSRF, IDOR, cross-tenant ids, privilege escalation, injection strings, hostile uploads, session lifecycle, brute force), plus code review of every route's `auth`/`perm`/`feature` declaration |
| Database | Catalogue-level tests (RLS forced on every tenant table, grants of the two runtime roles, FK index coverage, check constraints, cascades, numeric money, `timestamptz`), plus `EXPLAIN` checks on a 30k-lead workspace |
| SaaS / roles | Per-role navigation and action matrix, data-visibility rules, workspace switching with two workspaces, platform roles |
| Verification | lint, strict type checks, unit/integration/e2e suites, production build, migration status (see §8) |

## 2. Findings and fixes

Severity: **High** = security or data-integrity defect, **Medium** = functional bug or clearly broken UX, **Low** = polish / hardening.

### 2.1 Security

| # | Sev. | Finding | Fix | Evidence |
|---|---|---|---|---|
| S1 | High | **Login lockout never persisted.** The failed-attempt counter was written inside the request transaction, which is rolled back when the handler throws 401, so brute-force locking silently did nothing. | Counter is written with the global Prisma client (outside the request transaction). | `security.test.ts` "login does not reveal whether an account exists, and locks after repeated failures" |
| S2 | High | **Privilege escalation via role assignment.** A member allowed to change roles/invite could grant a role more powerful than their own. | `assertCanGrant(ctx, role)` used by invitations, role change and member routes: a role may only be granted if every permission in it is held by the actor. | `security.test.ts` "members cannot grant themselves or others more power than they have" |
| S3 | High | **Platform operators could read outbound email bodies** (verification/reset links, invitations) via the platform DB role. | Migration `20261125093000_platform_mailbox_privacy`: `REVOKE SELECT … FROM leadflow_platform`, insert-only. | `database.test.ts` "runtime roles are least-privilege" |
| S4 | Med | No CSRF defence beyond SameSite. | Origin guard on state-changing requests (allowed origins from `WEB_URL`, comma-separated); `Cache-Control: no-store` and `nosniff` on API responses. | `security.test.ts` CSRF test |
| S5 | Med | Sessions never expired from inactivity. | Idle timeout (`SESSION_IDLE_DAYS`, default 7) in `resolveSession`; logout revokes server-side; password change signs out other devices; deactivated users cut off immediately. | `security.test.ts` session lifecycle test |
| S6 | Med | Account enumeration by timing on login. | Dummy hash compare for unknown emails; identical error for unknown email and wrong password. | `security.test.ts` |
| S7 | Med | Uploads validated by extension only (fake `.xlsx`, zip bombs, binary-as-CSV, SVG logos with script). | `lib/upload.ts`: magic-byte checks, uncompressed zip size limit, row/column caps, CSV/Excel formula-injection neutralised, logos limited to small raster images (PNG/JPEG/WebP/GIF) whose bytes match the declared type. | `security.test.ts` upload tests |
| S8 | Med | Hostile input in filters returned HTTP 500 (`assignedToId=' OR 1=1 --`, bad enums/uuids, oversized JSON). | `csvUuids` / `csvEnum` validators, Prisma validation errors mapped to 400, oversized bodies to 413. No SQL is built by string concatenation (Prisma + parameterised raw queries). | `security.test.ts` "hostile input…" |
| S9 | Low | Dev-only endpoints/links reachable depending on env. | Fail-safe: anything other than `NODE_ENV=development|test` is production (no dev mailbox, no dev links, secure cookies). `ALLOW_DEV_TOOLS=false` disables them even in development. | `config.ts`, `security.test.ts` |
| S10 | Low | Missing browser hardening headers. | `next.config.ts`: `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and a restrictive `Content-Security-Policy` limited to `frame-ancestors`, `base-uri`, `form-action` and `object-src` (no script-src policy yet — see §5). | build output |

Cross-tenant / IDOR / authz checks that **passed without needing a fix** (kept as regression tests): every workspace endpoint requires authentication; a valid user using another workspace's id is refused with `NOT_A_MEMBER`; permission-gated endpoints refuse members lacking the permission; platform endpoints are closed to tenant users and billing endpoints to support admins; foreign ids for leads/tags/stages/members inside valid workspaces never resolve.

### 2.2 Database

All additions are additive (no data is dropped or rewritten). Four new migrations:

| Migration | Content |
|---|---|
| `20261125090000_audit_integrity_indexes` | Tenant-aware FKs: opportunity stage must belong to the opportunity's pipeline; lead / opportunity / follow-up / task / notification assignees must be **members of the same organization** (composite FK to `memberships`). State checks (completed follow-up has outcome + timestamps, done task has `completed_at`, paid invoice has `paid_at`, converted/lost lead has timestamp, subscription period order, lowercase user emails, non-negative plan prices). Case-insensitive unique names for stages, sources, tags, lost reasons, priorities. Partial indexes for scheduler / dashboard / report scans. |
| `20261125091000_fk_supporting_indexes` | An index for every foreign key that lacked one (enforced by a test, so future FKs without an index fail CI). |
| `20261125092000_stage_pipeline_index` | `(stage_id, pipeline_id)` index supporting the new composite FK. |
| `20261125093000_platform_mailbox_privacy` | See S3. |

Other findings:

| # | Sev. | Finding | Resolution |
|---|---|---|---|
| D1 | Med | A lead could be assigned (by SQL or a future bug) to a user outside its organization. | Composite FK above; test inserts directly with the owner role and expects rejection. |
| D2 | Med | Seed data violated the new "closed lead has a timestamp" check (found by re-seeding the dev DB). | Seed now writes `convertedAt` / `lostAt` / lost reason at creation. |
| D3 | Low | Query efficiency on large workspaces. | `EXPLAIN` test on a 30k-lead workspace confirms key list/scan queries use tenant/partial indexes. |
| D4 | Info | Money columns are `numeric`, every timestamp is `timestamptz`, history tables (`activities`, `audit_logs`, assignments) are append-only for the app role, cascades remove an organization's data without touching another tenant. | Verified by `database.test.ts`. |

### 2.3 Functional bugs and UX defects (web)

| # | Sev. | Finding | Fix |
|---|---|---|---|
| F1 | Med | **Kanban: dropping a deal on the pinned Won/Lost dock also broke dropping on the real Won/Lost column** (both registered the same droppable id). Found by the full-suite run after the dock was added. | Dock targets use `dock:<id>`; handlers map both. Regression test in `roles.spec.ts` (drag onto the dock) and the acceptance journey (drag onto the column). |
| F2 | Med | Won/Lost columns were off-screen while dragging; touch dragging fought with page scroll. | `OutcomeDock` + `TouchSensor` delay; empty-pipeline hint. |
| F3 | Med | Default (UTC) workspaces displayed "Africa/Abidjan" in timezone selects (the `Intl` list has no `UTC`). | `TIMEZONES` list with UTC first; `withCurrent` keeps stored values missing from the list. Unit tests. |
| F4 | Med | Nested `<form>` inside the lead form (TagPicker) caused a React hydration warning and unreliable Enter handling. | Replaced by a `div` with an Enter handler. |
| F5 | Med | Failed loads showed an empty table ("no results") instead of an error. | `ErrorState` (403 / 5xx / generic copy, retry button) and `DataTable error/onRetry`, used by leads, pipeline, opportunities, follow-ups, tasks, activity, team, automations, platform pages. Unit tests. |
| F6 | Low | No 404 or runtime-error page; no skip link; page titles did not follow the route. | `not-found.tsx`, `error.tsx`, skip-to-content link, `document.title` per page. |
| F7 | Low | Dashboard looked broken for brand-new workspaces. | "Getting started" checklist, per-chart empty states, KPI hints. |
| F8 | Low | Onboarding/settings: SVG logo upload accepted by the form (server rejects it), industry/timezone select fixes. | Form restricted to PNG/JPEG/WebP/GIF (matching the server's byte check); selects fixed. |
| F9 | Low | Leads toolbar crowded with rarely used actions. | "More lead tools" menu (duplicates, export, bulk tools). |
| F10 | Low | Billing confirmation copy implied an immediate plan change when the plan switch only issues an invoice from a trial. | Copy corrected. |

Findings that turned out to be **test-side only** (no product change): duplicate mobile-card/desktop-table DOM making `.first()` pick a hidden element, `aria-hidden` background behind modals, ambiguous accessible names ("Lead" vs "LeadFlow home"), required-asterisk in labels, rate-limited bulk registration. The e2e suite now uses scoped selectors and `DISABLE_RATE_LIMIT` via `npm run dev:e2e`.

### 2.4 Roles and SaaS behaviour

Verified through the UI (`roles.spec.ts`):

* Navigation and primary actions per role (owner, admin, manager, agent, viewer) match the permission catalogue; direct URLs to forbidden pages show "You don't have access to this page".
* Agents see only leads assigned to them (list and direct URL → "Lead not found"); managers, admins and viewers see all; dashboards state which scope they show.
* One user in two workspaces: the workspace switcher lists both, the choice survives a reload, data and team lists never leak between workspaces, and the API's `X-Org-Id` really changes the data set.
* Platform roles: support admin can suspend but cannot adjust subscriptions or edit plans; super admin can manage plans and platform roles; the platform area has its own navigation and shows no tenant lead data; tenant users are redirected away from `/platform`.
* Plan limits, trial → free, renewal → grace → read-only expiry and recovery after payment are covered by `business.test.ts` and the acceptance journey (billing page, plan switch refused with a clear message when active members exceed the new plan's limit).

## 3. Test inventory (after the audit)

| Suite | Count | Notes |
|---|---|---|
| API integration (Vitest + Supertest, real PostgreSQL, test DB recreated on every run) | **77** in 7 files | new: `security.test.ts` (15), `database.test.ts` (11) |
| Web unit (Vitest + Testing Library) | **16** in 2 files | new: `ErrorState`, `DataTable` error state, `TIMEZONES` |
| Playwright e2e (desktop + responsive projects) | **26** | acceptance journey (23 steps), leads, permissions, **modules (11, new)**, **roles (9, new)**, responsive |

## 4. Verification results (run on 2026-11-24)

| Check | Result |
|---|---|
| `npm run lint` (`eslint . --max-warnings=0`, new flat config) | clean |
| `npm run typecheck` (shared, api, web; strict) | clean |
| `npm test -w @leadflow/api` | 77 / 77 pass |
| `npx vitest run` (web) | 16 / 16 pass |
| `npm run build` (shared → Prisma client → API `tsc` → `next build`) | succeeds |
| Playwright, all projects, against the production web build with Playwright-started API + web servers | **26 / 26 pass** in the final run |
| `prisma migrate status` on the dev database | 7 migrations, schema up to date |
| Clean apply of all migrations on an empty database | exercised on every API test run (test DB is recreated from migrations) |
| `npm run docs:api` | regenerated; 152 endpoints documented |
| Seed | re-run after the integrity constraints; 2 organizations, 42 + 34 leads |

Honest notes on the runs:

* One earlier full run failed 1 of 26 tests (`follow-ups › schedule from the page…`: the "Complete" button was not found within 15 s). It could not be reproduced: it passed alone, in two further full runs of `modules.spec.ts` and in the final full run. The step now waits explicitly (30 s) for the row. Treat it as an unexplained intermittent timing failure, not as proven fixed.
* Two other full-run failures were real and were fixed (kanban drop target conflict F1; a garbled selector in `leads.spec.ts`).

## 5. Not verified / accepted risks

These are open. None is hidden by the test results above.

1. **No real email or payment provider** (by scope). Emails go to the dev mailbox table; payments are recorded manually (`MANUAL_DEV` / `MANUAL_PLATFORM`) and never simulated as successful card charges. A production deployment needs real adapters, bounce/complaint handling and a reviewed webhook flow.
2. **`npm audit`**: advisories remain in transitive dependencies (e.g. `uuid` via a dependency that only uses it for ids). An override attempt did not resolve it and was reverted; the affected code path (the `buf` argument of v3/v5/v6) is not used by this codebase. Re-run `npm audit` before deployment and update dependencies.
3. **Row-level security vs. trigram search**: with RLS policies, `ILIKE` on non-leakproof operators cannot use the trigram index; search relies on the tenant index plus a filter. Fine at the tested size (30k leads in one workspace); not load-tested beyond that.
4. **`users` table has no RLS** (needed for login). The API never lists users outside a workspace and the platform role cannot read CRM tables, but a bug in a future query could expose user rows across tenants. `created_by` / actor id columns on some history tables intentionally have no FK (users may be deactivated, history must survive).
5. **Manual SQL objects are not represented in `schema.prisma`** (composite FKs, partial indexes, check constraints, RLS). `prisma migrate dev` / `db pull` drift output will therefore never be empty; migrations are authoritative and are applied with `prisma migrate deploy`.
6. **Prisma `migrate reset` is blocked for AI agents**, so a destructive reset path was not exercised here; the dev database was cleaned with targeted deletes and re-seeded.
7. **Not tested**: real load/performance beyond the 30k-lead query-plan check, multi-instance deployment (the scheduler/worker must run as exactly one instance), browser matrix beyond Chromium, screen-reader testing (only keyboard/ARIA basics and a skip link), 2FA/SSO (not implemented), backups/restore, TLS/reverse-proxy configuration, observability.
8. Rate limits are per-process memory; a multi-instance deployment needs a shared store.
9. No `script-src` Content-Security-Policy is set (Next.js inline scripts would need a nonce setup); only framing/base/form/object directives are restricted.
10. Dev credentials in the README are for development only; the seed must never run against a production database.

## 6. Verdict

The code base passes every automated check listed in §4 in this environment, and the defects found by the audit (notably the non-persistent login lockout, role-grant escalation, cross-organization assignee gaps and the kanban drop-target conflict) are fixed and covered by tests. That is **not** a statement that the product is production-ready: the items in §5 — in particular real email/payment adapters, a dependency audit, load testing and an operational/deployment review — still have to be done and signed off before a production launch.
