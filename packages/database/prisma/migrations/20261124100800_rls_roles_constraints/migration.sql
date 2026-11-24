-- Row level security, runtime roles, grants and integrity constraints.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Roles (passwords are set by scripts/set-role-passwords.ts from env, never in SQL) ──
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadflow_app') THEN
    CREATE ROLE leadflow_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadflow_platform') THEN
    CREATE ROLE leadflow_platform LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- ── Tenant context helpers ──
CREATE OR REPLACE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- Background scheduler needs to enumerate workspaces without being able to read their data.
CREATE OR REPLACE FUNCTION app_list_active_orgs() RETURNS TABLE(id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT o.id FROM organizations o WHERE o.status = 'ACTIVE' $$;

-- ── Row level security on every tenant-owned table ──
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'roles','memberships','invitations','lead_sources','lead_priorities','lost_reasons','tags','custom_field_defs',
    'leads','lead_tags','lead_assignments','assignment_rules','pipelines','pipeline_stages','opportunities','stage_history',
    'follow_ups','follow_up_events','activities','tasks','task_comments','notifications','notification_preferences',
    'automation_rules','automation_executions','subscriptions','subscription_events','invoices','usage_records','audit_logs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id())', t);
  END LOOP;
END $$;

-- Workspaces: visible when active in context or when the current user is a member.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_write ON organizations USING (id = app_org_id()) WITH CHECK (id = app_org_id());
CREATE POLICY org_member_read ON organizations FOR SELECT
  USING (id IN (SELECT m.organization_id FROM memberships m WHERE m.user_id = app_user_id()));

-- A user can always see their own memberships (workspace switcher) — read only.
CREATE POLICY own_memberships_read ON memberships FOR SELECT USING (user_id = app_user_id());
-- Role names of workspaces the user belongs to (read only).
CREATE POLICY member_roles_read ON roles FOR SELECT
  USING (organization_id IN (SELECT m.organization_id FROM memberships m WHERE m.user_id = app_user_id()));
-- Invitations are looked up by their secret token before the invitee belongs to the workspace.
CREATE POLICY invite_by_token ON invitations FOR SELECT
  USING (token_hash = NULLIF(current_setting('app.invite_token', true), ''));
-- Subscription is visible to members (billing status banners), writes stay tenant scoped.
CREATE POLICY member_subscription_read ON subscriptions FOR SELECT
  USING (organization_id IN (SELECT m.organization_id FROM memberships m WHERE m.user_id = app_user_id()));

-- ── Integrity constraints ──
ALTER TABLE leads ADD CONSTRAINT leads_contact_required CHECK (email IS NOT NULL OR phone IS NOT NULL);
ALTER TABLE leads ADD CONSTRAINT leads_first_name_nonblank CHECK (length(btrim(first_name)) > 0);
ALTER TABLE opportunities ADD CONSTRAINT opportunities_value_nonneg CHECK (value >= 0);
ALTER TABLE pipeline_stages ADD CONSTRAINT stage_probability_range CHECK (probability BETWEEN 0 AND 100);
ALTER TABLE subscription_plans ADD CONSTRAINT plan_limits_positive CHECK (max_leads > 0 AND max_seats > 0);
ALTER TABLE invoices ADD CONSTRAINT invoice_amount_nonneg CHECK (amount >= 0);
-- Opportunity status and stage kind must agree with closing timestamps.
ALTER TABLE opportunities ADD CONSTRAINT opportunity_won_has_timestamp CHECK (status <> 'WON' OR won_at IS NOT NULL);
ALTER TABLE opportunities ADD CONSTRAINT opportunity_lost_has_timestamp CHECK (status <> 'LOST' OR lost_at IS NOT NULL);
-- Exactly one default, non-archived pipeline per workspace.
CREATE UNIQUE INDEX one_default_pipeline_per_org ON pipelines (organization_id) WHERE is_default AND archived_at IS NULL;
-- One pending invitation per email per workspace.
CREATE UNIQUE INDEX one_pending_invite_per_email ON invitations (organization_id, lower(email)) WHERE status = 'PENDING';

-- Trigram indexes: fast ILIKE '%term%' lead search.
CREATE INDEX leads_first_name_trgm ON leads USING gin (first_name gin_trgm_ops);
CREATE INDEX leads_last_name_trgm ON leads USING gin (last_name gin_trgm_ops);
CREATE INDEX leads_email_trgm ON leads USING gin (email gin_trgm_ops);
CREATE INDEX leads_company_trgm ON leads USING gin (company_name gin_trgm_ops);
CREATE INDEX leads_phone_trgm ON leads USING gin (phone gin_trgm_ops);
CREATE INDEX leads_active_idx ON leads (organization_id, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX follow_ups_pending_due_idx ON follow_ups (organization_id, due_at) WHERE status = 'PENDING';

-- ── Grants: application role ──
GRANT USAGE ON SCHEMA public TO leadflow_app, leadflow_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO leadflow_app;
REVOKE INSERT, UPDATE, DELETE ON subscription_plans FROM leadflow_app;
-- Historical records are append-only for the application.
REVOKE UPDATE, DELETE ON audit_logs, lead_assignments, stage_history, follow_up_events, subscription_events, activities FROM leadflow_app;
GRANT UPDATE (lead_id) ON activities TO leadflow_app; -- only used by lead merge
GRANT EXECUTE ON FUNCTION app_list_active_orgs() TO leadflow_app;

-- ── Grants: platform administration role ──
-- Deliberately has NO access to leads, opportunities, follow-ups, activities, tasks, notes or
-- any other private customer CRM data. It sees accounts, plans, billing and aggregate usage only.
GRANT SELECT, UPDATE ON organizations TO leadflow_platform;
GRANT SELECT, UPDATE ON users TO leadflow_platform;
GRANT SELECT, UPDATE ON sessions TO leadflow_platform;
GRANT SELECT ON memberships, roles TO leadflow_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_plans TO leadflow_platform;
GRANT SELECT, INSERT, UPDATE ON subscriptions, invoices, usage_records TO leadflow_platform;
GRANT SELECT, INSERT ON subscription_events, audit_logs, outbound_emails TO leadflow_platform;

CREATE VIEW platform_org_overview AS
SELECT o.id AS organization_id,
       (SELECT count(*) FROM leads l WHERE l.organization_id = o.id AND l.archived_at IS NULL)::int AS lead_count,
       (SELECT count(*) FROM opportunities p WHERE p.organization_id = o.id)::int AS opportunity_count,
       (SELECT count(*) FROM memberships m WHERE m.organization_id = o.id AND m.status = 'ACTIVE')::int AS seat_count,
       (SELECT max(l.created_at) FROM leads l WHERE l.organization_id = o.id) AS last_lead_at
FROM organizations o;
GRANT SELECT ON platform_org_overview TO leadflow_platform;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO leadflow_app;
