# API documentation

Base URL `/api` (the web app proxies it; direct API port 4000). Interactive docs: **/api/docs** (Swagger UI) · machine-readable: **/api/openapi.json** · snapshot: `docs/openapi.json`.

## Conventions
* **Auth** – httpOnly session cookie `lf_session` set by `POST /api/auth/login` (also accepts `Authorization: Bearer <token>`).
* **Workspace** – every tenant route needs `X-Org-Id: <organization uuid>`. The server verifies the caller's active membership; otherwise `403 NOT_A_MEMBER`.
* **Success** – `{ "data": … }`; lists add `"meta": { page, pageSize, total, totalPages }`. Exports return files (CSV / XLSX).
* **Errors** – `{ "error": { "code", "message", "details?" } }`. Validation errors: `400 VALIDATION_ERROR` with `details.fields`. Other codes: `401 UNAUTHENTICATED`, `403 FORBIDDEN | MISSING_PERMISSION | NOT_A_MEMBER | MEMBER_DEACTIVATED | WORKSPACE_SUSPENDED | PLATFORM_ONLY`, `402 FEATURE_NOT_IN_PLAN | LEAD_LIMIT_REACHED | SEAT_LIMIT_REACHED | SUBSCRIPTION_EXPIRED`, `404 NOT_FOUND` (also returned for other tenants' ids), `409 DUPLICATE | DUPLICATE_LEAD | CONFLICT`.
* **Pagination** – `?page=1&pageSize=25` (max 200). Dates are ISO-8601 UTC.
* **Rate limiting** – auth endpoints are rate-limited (disabled in tests).

## Endpoints
Legend: **perm** = any-of permission required (otherwise any workspace member); **feature** = plan feature required; `auth`: *public*, *user* (signed in, no workspace), *org* (workspace member), *platform* (platform administrator).

### Authentication

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| POST | `/api/auth/register` | public | — | Register a new user account |
| POST | `/api/auth/verify-email` | public | — | Confirm an email address |
| POST | `/api/auth/resend-verification` | public | — | Resend the verification email |
| POST | `/api/auth/login` | public | — | Sign in (sets an httpOnly session cookie) |
| GET | `/api/auth/me` | user | — | Current user and workspaces |
| POST | `/api/auth/logout` | public | — | Sign out |
| POST | `/api/auth/forgot-password` | public | — | Request a password reset link |
| POST | `/api/auth/reset-password` | public | — | Set a new password using a reset token |
| PATCH | `/api/auth/profile` | user | — | Update my profile |
| POST | `/api/auth/change-password` | user | — | Change my password |
| GET | `/api/auth/sessions` | user | — | List my active sessions |
| DELETE | `/api/auth/sessions/{id}` | user | — | Revoke one of my sessions |
| POST | `/api/auth/sessions/revoke-others` | user | — | Sign out of all other devices |
| GET | `/api/auth/invitation` | public | — | Preview an invitation |
| POST | `/api/auth/invitation/accept` | user | — | Accept a workspace invitation |

### Workspaces

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| POST | `/api/organizations` | user | — | Create a workspace (caller becomes Owner) |
| GET | `/api/organizations/current` | org | — | Current workspace details, plan and usage |
| PATCH | `/api/organizations/current` | org | settings.manage | Update company profile & workspace configuration |
| POST | `/api/organizations/current/onboarding` | org | settings.manage | Save onboarding wizard step / complete onboarding |
| GET | `/api/organizations/current/roles-summary` | org | — | Role keys |

### Team

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/members` | org | team.view \| team.manage \| leads.assign | List workspace members with workload |
| PATCH | `/api/members/{id}` | org | team.manage | Change role / activate / deactivate a member |
| GET | `/api/invitations` | org | team.manage | List invitations |
| POST | `/api/invitations` | org | team.manage | Invite a team member by email |
| POST | `/api/invitations/{id}/resend` | org | team.manage | Re-issue an invitation link |
| DELETE | `/api/invitations/{id}` | org | team.manage | Revoke an invitation |
| GET | `/api/permissions` | org | — | Permission catalogue |
| GET | `/api/roles` | org | — | List roles |
| POST | `/api/roles` | org | roles.manage; feature: custom_roles | Create a custom role |
| PATCH | `/api/roles/{id}` | org | roles.manage | Edit a role |
| DELETE | `/api/roles/{id}` | org | roles.manage | Delete a custom role |

### Workspace settings

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/lead-sources` | org | — | List lead source |
| POST | `/api/lead-sources` | org | settings.manage | Create lead source |
| PATCH | `/api/lead-sources/{id}` | org | settings.manage | Update lead source |
| DELETE | `/api/lead-sources/{id}` | org | settings.manage | Delete or deactivate lead source |
| GET | `/api/lead-priorities` | org | — | List lead priority |
| POST | `/api/lead-priorities` | org | settings.manage | Create lead priority |
| PATCH | `/api/lead-priorities/{id}` | org | settings.manage | Update lead priority |
| DELETE | `/api/lead-priorities/{id}` | org | settings.manage | Delete or deactivate lead priority |
| GET | `/api/lost-reasons` | org | — | List lost reason |
| POST | `/api/lost-reasons` | org | settings.manage | Create lost reason |
| PATCH | `/api/lost-reasons/{id}` | org | settings.manage | Update lost reason |
| DELETE | `/api/lost-reasons/{id}` | org | settings.manage | Delete or deactivate lost reason |
| GET | `/api/tags` | org | — | List tag |
| POST | `/api/tags` | org | leads.update | Create tag |
| PATCH | `/api/tags/{id}` | org | leads.update | Update tag |
| DELETE | `/api/tags/{id}` | org | leads.update | Delete or deactivate tag |
| GET | `/api/custom-fields` | org | — | List custom lead fields |
| POST | `/api/custom-fields` | org | settings.manage; feature: custom_fields | Create a custom field |
| PATCH | `/api/custom-fields/{id}` | org | settings.manage; feature: custom_fields | Update a custom field |
| DELETE | `/api/custom-fields/{id}` | org | settings.manage | Deactivate a custom field (values are preserved on leads) |

### Leads

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/leads` | org | — | List leads (search, filters, sort, pagination) |
| POST | `/api/leads` | org | leads.create | Create a lead (duplicate detection, auto-assignment, plan limit) |
| POST | `/api/leads/check-duplicates` | org | leads.create \| leads.update | Look for existing leads with the same email/phone |
| GET | `/api/leads/duplicates` | org | leads.merge | Scan the workspace for duplicate lead groups |
| POST | `/api/leads/merge` | org | leads.merge | Merge a duplicate lead into another |
| POST | `/api/leads/bulk` | org | leads.update \| leads.assign \| leads.archive | Bulk assign / status / archive / tag / priority (all-or-nothing validation) |
| GET | `/api/leads/import/template` | org | leads.import; feature: import_export | Download the CSV import template |
| POST | `/api/leads/import` | org | leads.import; feature: import_export | Import leads from CSV/XLSX (multipart "file"; ?dryRun=true to validate only) |
| GET | `/api/leads/export` | org | leads.export; feature: import_export | Export leads (CSV or XLSX), honouring filters / selected ids |
| GET | `/api/leads/{id}` | org | — | Lead detail |
| PATCH | `/api/leads/{id}` | org | leads.update | Update a lead |
| POST | `/api/leads/{id}/archive` | org | leads.archive | Archive a lead (history is preserved) |
| POST | `/api/leads/{id}/restore` | org | leads.archive | Restore an archived lead |
| POST | `/api/leads/{id}/assign` | org | leads.assign | Assign / reassign / unassign a lead |
| GET | `/api/leads/{id}/assignments` | org | — | Assignment history |
| GET | `/api/leads/{id}/activities` | org | — | Chronological activity timeline |
| POST | `/api/leads/{id}/activities` | org | leads.update | Manually log a call / email / WhatsApp / meeting / note |
| GET | `/api/leads/{id}/followups` | org | — | Follow-up history for a lead |

### Pipelines

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/pipelines` | org | — | List pipelines with stages and open deal counts |
| POST | `/api/pipelines` | org | settings.manage; feature: custom_pipelines | Create a pipeline (starts with the standard stages) |
| PATCH | `/api/pipelines/{id}` | org | settings.manage | Rename / set default pipeline |
| DELETE | `/api/pipelines/{id}` | org | settings.manage | Archive a pipeline |
| POST | `/api/pipelines/{id}/stages` | org | settings.manage | Add a stage (open stages are inserted before Won/Lost) |
| POST | `/api/pipelines/{id}/stages/reorder` | org | settings.manage | Reorder stages (Won/Lost stay last) |
| PATCH | `/api/stages/{id}` | org | settings.manage | Edit a stage |
| DELETE | `/api/stages/{id}` | org | settings.manage | Delete an unused stage |

### Opportunities

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/opportunities` | org | — | List opportunities (table view) |
| GET | `/api/opportunities/board` | org | — | Kanban board data for a pipeline |
| POST | `/api/opportunities` | org | opportunities.manage | Create an opportunity for a lead |
| GET | `/api/opportunities/{id}` | org | — | Opportunity detail with stage history |
| PATCH | `/api/opportunities/{id}` | org | opportunities.manage | Edit opportunity details |
| POST | `/api/opportunities/{id}/move` | org | opportunities.manage | Move to a stage (drag & drop / win / lose). Lost requires a reason. |
| DELETE | `/api/opportunities/{id}` | org | opportunities.manage | Archive an opportunity |

### Follow-ups

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/followups` | org | — | List follow-ups (today / upcoming / overdue / history) |
| GET | `/api/followups/summary` | org | — | Follow-up counters (overdue / today / upcoming / completed today) |
| POST | `/api/followups` | org | followups.manage | Schedule a follow-up |
| GET | `/api/followups/{id}` | org | — | Follow-up detail with full history |
| PATCH | `/api/followups/{id}` | org | followups.manage | Edit / reassign a pending follow-up |
| POST | `/api/followups/{id}/complete` | org | followups.manage | Complete with a recorded outcome (never silent); optionally schedule the next one |
| POST | `/api/followups/{id}/reschedule` | org | followups.manage | Reschedule (history is preserved) |
| POST | `/api/followups/{id}/cancel` | org | followups.manage | Cancel a follow-up |
| GET | `/api/calendar` | org | — | Calendar events (follow-ups and tasks) for a date window |

### Tasks

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/tasks` | org | — | List tasks (my / team / overdue / completed) |
| POST | `/api/tasks` | org | tasks.manage | Create a task (optionally linked to a lead / opportunity) |
| GET | `/api/tasks/{id}` | org | — | Task detail with comments |
| PATCH | `/api/tasks/{id}` | org | tasks.manage | Update a task / change status |
| DELETE | `/api/tasks/{id}` | org | tasks.manage | Cancel a task |
| POST | `/api/tasks/{id}/comments` | org | tasks.manage | Comment on a task |

### Notifications

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/notifications` | org | — | My notifications |
| GET | `/api/notifications/unread-count` | org | — | Unread notification count |
| POST | `/api/notifications/read-all` | org | — | Mark all notifications read |
| POST | `/api/notifications/{id}/read` | org | — | Mark one notification read |
| POST | `/api/notifications/{id}/unread` | org | — | Mark one notification unread |
| GET | `/api/notifications/preferences` | org | — | My notification preferences |
| PUT | `/api/notifications/preferences` | org | — | Update my notification preferences |

### Activity

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/activities` | org | — | Workspace activity log |

### Automations

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/automations` | org | automations.manage \| settings.manage | List automation rules |
| POST | `/api/automations` | org | automations.manage; feature: automations | Create an automation rule |
| PATCH | `/api/automations/{id}` | org | automations.manage; feature: automations | Update an automation rule |
| POST | `/api/automations/{id}/toggle` | org | automations.manage | Enable / disable a rule |
| DELETE | `/api/automations/{id}` | org | automations.manage | Delete a custom rule (system templates can only be disabled) |
| GET | `/api/automations/executions` | org | automations.manage \| settings.manage | Execution log |
| POST | `/api/automations/executions/{id}/retry` | org | automations.manage | Retry a failed (or skipped) execution |
| GET | `/api/assignment-rules` | org | leads.assign \| settings.manage | List assignment rules |
| POST | `/api/assignment-rules` | org | settings.manage; feature: rule_assignment | Create an assignment rule |
| PATCH | `/api/assignment-rules/{id}` | org | settings.manage; feature: rule_assignment | Update an assignment rule |
| DELETE | `/api/assignment-rules/{id}` | org | settings.manage | Delete an assignment rule |

### Audit

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/audit-logs` | org | settings.manage | Workspace audit trail (sensitive operations) |

### Billing

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/billing` | org | billing.view \| billing.manage | Subscription, usage, invoices and history |
| POST | `/api/billing/change-plan` | org | billing.manage | Upgrade / downgrade. Upgrades issue an invoice that activates when paid; downgrades apply at period end. |
| POST | `/api/billing/cancel` | org | billing.manage | Cancel at period end |
| POST | `/api/billing/reactivate` | org | billing.manage | Undo a scheduled cancellation / downgrade; for an expired workspace issue a renewal invoice |
| GET | `/api/billing/invoices/{id}` | org | billing.view \| billing.manage | Invoice detail |
| POST | `/api/billing/invoices/{id}/record-payment` | org | billing.manage | DEVELOPMENT / MANUAL: record that an invoice was paid outside the system |

### Reports & Analytics

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/dashboard` | org | — | Dashboard KPIs, charts and attention lists (permission-aware) |
| GET | `/api/reports` | org | reports.view | Report catalogue |
| GET | `/api/reports/{key}` | org | reports.view | Run a report (add format=csv/xlsx to export) |

### Platform administration

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/platform/dashboard` | platform | — | Platform KPIs |
| GET | `/api/platform/organizations` | platform | — | Registered organizations |
| GET | `/api/platform/organizations/{id}` | platform | — | Organization details (no lead data) |
| POST | `/api/platform/organizations/{id}/suspend` | platform | — | Suspend an organization |
| POST | `/api/platform/organizations/{id}/activate` | platform | — | Re-activate a suspended organization |
| GET | `/api/platform/users` | platform | — | All users |
| POST | `/api/platform/users/{id}/status` | platform | — | Activate / deactivate a user account (revokes sessions) |
| POST | `/api/platform/users/{id}/platform-role` | platform | — | Grant / revoke a platform administrator role |
| GET | `/api/platform/plans` | platform | — | Subscription plans |
| POST | `/api/platform/plans` | platform | — | Create a plan |
| PATCH | `/api/platform/plans/{id}` | platform | — | Update a plan (existing subscribers pick up new limits immediately) |
| DELETE | `/api/platform/plans/{id}` | platform | — | Retire a plan (hidden for new subscriptions) |
| GET | `/api/platform/subscriptions` | platform | — | Subscription monitoring |
| POST | `/api/platform/subscriptions/{orgId}/adjust` | platform | — | Manual subscription adjustment (audited) |
| GET | `/api/platform/invoices` | platform | — | Invoices across organizations |
| POST | `/api/platform/invoices/{id}/mark-paid` | platform | — | MANUAL: record a payment received outside the system |
| POST | `/api/platform/invoices/{id}/mark-failed` | platform | — | Record a failed payment |
| POST | `/api/platform/invoices/{id}/void` | platform | — | Void an unpaid invoice |
| GET | `/api/platform/usage` | platform | — | Usage vs plan limits per organization |
| GET | `/api/platform/audit-logs` | platform | — | Platform audit trail |
| GET | `/api/platform/health` | platform | — | System health |

### System

| Method | Path | Auth | Permission / feature | Summary |
|---|---|---|---|---|
| GET | `/api/health` | public | — | Liveness probe |
| GET | `/api/dev/mailbox` | public | — | DEV ONLY: list outbound emails |
| POST | `/api/dev/scheduler/tick` | public | — | DEV ONLY: run the background scheduler once |

