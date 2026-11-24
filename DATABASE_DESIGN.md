# Database design

PostgreSQL 16, shared database / shared schema, UUID primary keys, `timestamptz` (UTC) timestamps, `numeric` money, soft-delete via `archived_at`.

## Entity overview
```
Global                         Tenant-owned (all have organization_id, RLS-protected)
users ─< sessions              organizations ─< memberships >─ users
users ─< auth_tokens           organizations ─< roles (permissions text[])
outbound_emails (dev)          organizations ─< invitations
subscription_plans             lead_sources · lead_priorities · lost_reasons · tags · custom_field_defs
                               leads ─< lead_tags >─ tags
                               leads ─< lead_assignments (append-only)
                               leads ─< opportunities ─< stage_history
                               pipelines ─< pipeline_stages ─< opportunities
                               leads ─< follow_ups ─< follow_up_events
                               leads ─< activities (append-only timeline)
                               tasks ─< task_comments        (tasks link to lead and/or opportunity)
                               notifications · notification_preferences
                               automation_rules ─< automation_executions · assignment_rules
                               subscriptions · subscription_events · invoices · usage_records · audit_logs
```

## Tenant isolation
* Every tenant table has `organization_id NOT NULL`.
* **Composite tenant-aware foreign keys**: referenced tables carry `UNIQUE (id, organization_id)`; children reference `(parent_id, organization_id)`. Example: `leads(source_id, organization_id) → lead_sources(id, organization_id)`. A lead therefore cannot point at another tenant's source, stage, pipeline, tag or lost reason — enforced by PostgreSQL, even if application code were wrong.
* **Row level security** `ENABLE`+`FORCE` on all tenant tables with policy `organization_id = app_org_id()` (reads the transaction-local `app.org_id`). Additional read-only policies let a user see *their own* memberships/roles/organization/subscription rows (workspace switcher) and look up a pending invitation by its secret token hash.
* Roles: `leadflow_app` (runtime, no BYPASSRLS), `leadflow_platform` (BYPASSRLS, grants limited to accounts/billing/aggregates), owner role for migrations.
* `app_list_active_orgs()` (SECURITY DEFINER) lets the scheduler enumerate workspace ids without being able to read their data. `invitation_preview(token_hash)` exposes only what the accept page needs.

## Integrity constraints (selection)
| Constraint | Meaning |
|---|---|
| `leads_contact_required` | email **or** phone must be present |
| `leads (organization_id, email_normalized/phone_normalized)` indexes | duplicate detection |
| `opportunity_won_has_timestamp`, `opportunity_lost_has_timestamp` | WON/LOST status requires `won_at`/`lost_at` |
| `one_default_pipeline_per_org` (partial unique) | exactly one default pipeline |
| `one_pending_invite_per_email` (partial unique) | no duplicate pending invitations |
| `UNIQUE (rule_id, event_key)` on `automation_executions` | an event can never run a rule twice |
| `UNIQUE (user_id, dedupe_key)` on `notifications` | reminders are never duplicated |
| `UNIQUE (organization_id, day)` on `usage_records` | one usage snapshot per day |
| value/amount/probability/limit CHECKs | non-negative money, 0–100 probability, positive plan limits |

Indexes: tenant-leading composites for every list query (`(organization_id, status, due_at)` etc.), partial index for pending follow-ups and active leads, `pg_trgm` GIN indexes on name/email/company/phone for `ILIKE '%term%'` search.

## Append-only history
`lead_assignments`, `stage_history`, `follow_up_events`, `subscription_events`, `audit_logs`, `activities`: the runtime role has INSERT/SELECT only. Archiving a lead sets `archived_at`; merging marks the source `archived_at` + `merged_into_id`, moves child rows to the target and logs a `LEAD_MERGED` activity.

## Notable tables
* **leads** — contact data, normalised email/phone, `status`, `assigned_to_id`, `first_contacted_at` (drives response-time/contact-rate), `last_activity_at` (drives inactivity), `custom_fields jsonb`.
* **opportunities** — `pipeline_id`, `stage_id`, `value numeric(14,2)`, `status`, `owner_id`, `stage_entered_at`, `position` (kanban ordering), lost reason & note.
* **follow_ups** — `due_at`, `assigned_to_id`, `status` (PENDING/COMPLETED/CANCELED), `outcome`, `completed_at/by`, `reschedule_count`, reminder flags.
* **subscriptions / invoices** — plan, interval, status, trial/period/grace dates, pending (scheduled) plan change; invoices carry period, amount, status, payment method/reference/recorder or failure reason.

Migrations live in `packages/database/prisma/migrations`; see ENVIRONMENT_SETUP.md for how to apply them.
