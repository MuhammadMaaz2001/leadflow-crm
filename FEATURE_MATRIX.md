# Feature completion matrix

Date: 2026-11-25 · Branch `claude/dreamy-sagan-nvy31g` · Method: every row was checked against the **code and the database**, not against earlier reports; the test column names the automated test that exercises it (API = `apps/api/test`, E2E = `apps/web/e2e`).

Status legend
* **✅ Verified** — implemented and covered by an automated test that runs against real PostgreSQL/Redis (and the real browser for UI).
* **🔬 Needs external validation** — implemented and tested with a test double or in-process fake; the real service has not been exercised here.
* **◑ Partial** — works, with a stated limit.
* **✗ Missing** — not implemented.
* **⛔ Blocked** — cannot be done without an external dependency/decision.

## 1. Leads
| Capability | Status | Evidence / limit |
|---|---|---|
| Create / edit / view / archive / restore, duplicate protection (email, phone, name+company) | ✅ | `business.test`, `leads-complete.test`, E2E `acceptance`, `leads` |
| CSV **and** Excel import with preview, row validation, per-row error report, duplicate handling (skip / update / import), plan-limit check, hard cap with a clear error (no silent truncation) | ✅ | `leads-complete.test` (cap, duplicates, errors, plan limit) · ◑ synchronous, 2,000 rows per file |
| Export CSV / Excel of the **filtered** set including custom fields, formula-injection safe, capped with an explicit error | ✅ | `leads-complete.test` · ◑ 20,000 rows per export |
| Duplicate detection and **merge** (field choices, activities/tasks/follow-ups/deals moved, tags unioned, audit) | ✅ | `business.test`, `leads-complete.test` |
| Custom fields (text, number, date, select, boolean): strict validation, no silent truncation/coercion, required fields, definition locks once data exists | ✅ | `leads-complete.test` |
| Tags: create/rename/delete restricted by permission (agents cannot rename or delete) | ✅ | `leads-complete.test` |
| Bulk actions: assign, status, tag add/remove, archive, delete-to-archive; partial failures reported | ✅ | `business.test`, `assignment.test` |
| Search, filters (status, owner, source, tags, date ranges, unassigned, no activity) and sorting | ✅ | `business.test`, E2E `leads` |
| **Saved views stored on the server** (private or shared, per workspace, per permission) | ✅ | `leads-complete.test`, E2E `leads` (saved-views step) — replaces the browser-only views |
| Ownership rules (agents see/edit only what they own; managers see all; viewer read-only) | ✅ | `security.test`, `assignment.test`, E2E `roles` |
| Timeline of every change | ✅ | `business.test`, E2E `acceptance` |
| File attachments on leads | ✗ | not built (private S3 storage exists for logos) |

## 2. Opportunities and pipeline
| Capability | Status | Evidence / limit |
|---|---|---|
| Several deals per lead; independent values/stages | ✅ | `pipeline-integrity.test` |
| Pipelines and stages (create, reorder, win-probability, OPEN/WON/LOST kinds) | ✅ | `business.test`, `pipeline-integrity.test` |
| Kanban (drag and drop, outcome dock) and table view | ✅ | E2E `acceptance`, `modules` |
| **Lost requires a valid reason of the same workspace**; reopening clears the outcome; new deals start open; values/dates validated; stage history kept | ✅ | `pipeline-integrity.test` |
| Reports/dashboard exclude deals of archived leads and deals outside the range | ✅ | `reports-verify.test` |
| Weighted forecast | ✅ | `reports-verify.test` |

## 3. Team, assignment, ownership
| Capability | Status | Evidence / limit |
|---|---|---|
| Manual, bulk, round-robin and rule-based assignment, with history (`lead_assignments`) | ✅ | `assignment.test` |
| Round-robin fairness, skips inactive members and respects capacity | ✅ | `assignment.test` |
| Deactivating a member **must hand over** their open leads, deals, follow-ups, tasks (or explicitly leave unassigned); no orphaned work | ✅ | `assignment.test`, E2E `completeness` |
| Cross-workspace assignment impossible (composite FKs + RLS + API checks) | ✅ | `security.test`, `database.test`, `assignment.test` |
| Role-based permissions (owner/admin/manager/agent/viewer + custom roles) | ✅ | `security.test`, E2E `roles` |

## 4. Activities, follow-ups, tasks, calendar, notifications
| Capability | Status | Evidence / limit |
|---|---|---|
| Call/email/WhatsApp/meeting/note logging (**records** the interaction, never sends anything) | ✅ | `activity-tasks.test` |
| Follow-ups with mandatory outcome, overdue derived (never stored), reschedule, cancel with reason | ✅ | `business.test`, `activity-tasks.test` |
| Tasks: assign, due dates, priority, complete, overdue | ✅ | `activity-tasks.test` |
| Calendar (follow-ups, tasks) in the workspace timezone | ✅ ◑ | E2E `modules` · agenda-style, no drag-to-reschedule |
| In-app reminders for follow-ups **and tasks** (due soon, overdue), no duplicates, no reminders for archived leads | ✅ | `activity-tasks.test`, `automation-engine.test` |
| In-app notifications: per user, read/unread/clear, preferences, never cross users/workspaces | ✅ | `activity-tasks.test` |
| Email / SMS / WhatsApp **delivery** | ⛔ | by scope: nothing is sent; emails go to the outbox (dev mailbox or SMTP) and statuses are honest |

## 5. Automation
| Capability | Status | Evidence / limit |
|---|---|---|
| Triggers: lead created, lead assigned, lead not contacted, follow-up overdue, lead inactive, lead converted | ✅ | `automation-engine.test` |
| Actions: notify, create task, set priority, **assign lead** (user or round-robin), **create follow-up** (max 5 actions per rule) | ✅ | `automation-engine.test` |
| Conditions, edit, enable/disable, execution log, manual retry | ✅ | `automation-engine.test`, E2E `completeness` |
| Safety: no trigger loops from automation actions, hourly execution budget per workspace (excess events dropped with a log warning), rule-count cap, exactly-once (row lock + idempotency), all-or-nothing, per-workspace isolation, archived leads skipped | ✅ | `automation-engine.test`, `infra.test` |
| Retry/backoff of failed executions; `attempts` counted | ✅ | `automation-engine.test`, `infra.test` |

## 6. Reports and dashboard
| Capability | Status | Evidence / limit |
|---|---|---|
| Dashboard KPIs and charts consistent with the reports | ✅ | `reports-verify.test` (independent JS recomputation from raw rows) |
| 14 reports: lead generation, source, assignment (event-based), contact performance, follow-up, pipeline, conversion, lost, salesperson, lead aging, response time, **lead status, activity, task performance** | ✅ | `reports-verify.test` (every figure compared with raw rows; agent scope; second workspace sees nothing; every report + CSV runs) |
| Scope/tenant safety: agents forced to own data; other workspaces invisible | ✅ | `reports-verify.test`, `security.test` |
| CSV / Excel export, formula-injection safe | ✅ | `reports-verify.test`, `business.test` |
| Definitions documented | ✅ | `docs/REPORTING_DEFINITIONS.md` |

## 7. Billing — **manual only**
| Capability | Status | Evidence / limit |
|---|---|---|
| Platform admins (SUPER/BILLING) record a payment received **outside** the system; owners cannot pay or extend (tenant self-pay endpoint removed; DB triggers refuse paid invoices/expiry extensions from the tenant role) | ✅ | `manual-billing.test`, `payments.test`, `security.test`, E2E `modules` |
| Extension choices: 1 / 3 / 6 / 12 months or custom days; preview shows **previous and new expiry** before confirming | ✅ | `manual-billing.test` |
| Extension policy (from current expiry, grace continuity, trial end, payment date, plan change); calendar months in workspace timezone; month-end and DST cases | ✅ | `manual-billing.test` |
| Atomic: subscription, invoice, receipt, history and audit in one transaction with row lock; idempotency key and unique reference prevent double extension; concurrent confirmations tested | ✅ | `manual-billing.test` |
| Payment history, receipts, notes, internal notes, subscription history, reversal of the latest payment (restores previous state) | ✅ | `manual-billing.test` |
| Payments table append-only for tenants (RLS read-only, no write grant) | ✅ | `manual-billing.test`, `database.test` |
| Invoices, plan change, suspension, expiry → grace → downgrade lifecycle | ✅ | `business.test`, `manual-billing.test` |
| Payment-provider abstraction (no provider configured; settlement contract + event ledger) | 🔬 | `payments.test` with a test double — no provider integrated by design |
| Online payments (Stripe/Paddle/…) | ⛔ | deliberately not integrated |

## 8. Plan limits and data safety
| Capability | Status | Evidence / limit |
|---|---|---|
| Limits enforced in the backend (members, leads, pipelines, automations, plan features such as advanced reports/export) and in the UI; trial end → Free keeps everything and refuses only NEW usage beyond limits | ✅ | `plan-enforcement.test` |
| Downgrade is refused while usage exceeds the target plan (or scheduled for period end and cancelable); grace keeps full access; expiry/suspension makes modules read-only with a precise error code; billing stays reachable; a confirmed payment restores access; nothing is deleted | ✅ | `plan-enforcement.test` |
| Leads are archived/restored rather than destroyed from the UI | ✅ | `business.test`, `leads-complete.test` |

## 9. Security, runtime, operations
| Capability | Status | Evidence / limit |
|---|---|---|
| RLS forced, composite tenant FKs, restricted roles, startup probe | ✅ | `database.test`, `db:verify` |
| CSRF, CSP (nonce), headers, cookies, sessions, lockout, rate limits, upload validation | ✅ | `security.test`, E2E `security` |
| Distributed rate limits / locks, scheduler lease, worker shutdown, retries | ✅ | `infra.test`, `operations.test`, real-process tests |
| Health: live/ready, platform health page (workers, scheduler, queue, **applied migrations, providers**) | ✅ | `operations.test`, E2E `modules` |
| Structured logs, request ids, slow-query log, error hook | ✅ | `operations.test` |
| Private S3 object storage adapter (authenticated serving) | 🔬 | `storage.test` against an in-process fake S3 only |
| SMTP delivery | 🔬 | outbox + test double; real SMTP not run |
| Two-factor authentication / SSO | ✗ | not built |
| Docker/hosting deployment | 🔬 | files written, never built here (no Docker) |
| Metrics exporter (Prometheus/OTel) | ✗ | logs + health only |

## 10. Frontend completeness
| Capability | Status | Evidence / limit |
|---|---|---|
| No inert controls: every button/menu/filter on the pages added or changed in this phase is wired to an API and exercised in a browser | ✅ | E2E `completeness`, `modules`, `leads` |
| Responsive (390 px / 1440 px) with no horizontal overflow, including the new platform billing card | ✅ | E2E `responsive`, `completeness` |
| Dark mode, accessibility audit beyond keyboard/ARIA basics, drag-to-reschedule calendar | ✗ | not built |

## Counts
Verified ✅: all rows marked ✅ · Needs external validation 🔬: 4 · Partial ◑: 3 limits (sync import cap, export cap, agenda calendar) · Missing ✗: 5 (attachments, 2FA/SSO, metrics exporter, dark mode, calendar drag) · Blocked ⛔: 2 (message delivery, online payments — by scope).
