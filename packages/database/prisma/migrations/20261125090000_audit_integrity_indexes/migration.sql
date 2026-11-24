-- Audit hardening (additive only — no data is dropped or rewritten).

-- ── Tenant-aware foreign keys ────────────────────────────────────────────────
-- An opportunity's stage must belong to the opportunity's own pipeline.
ALTER TABLE opportunities
  ADD CONSTRAINT opportunities_stage_pipeline_fk FOREIGN KEY (stage_id, pipeline_id) REFERENCES pipeline_stages (id, pipeline_id);

-- People referenced by tenant rows must be members of THAT organization
-- (memberships are never hard-deleted: users are deactivated, so history keeps resolving).
ALTER TABLE leads ADD CONSTRAINT leads_assignee_member_fk FOREIGN KEY (organization_id, assigned_to_id) REFERENCES memberships (organization_id, user_id);
ALTER TABLE opportunities ADD CONSTRAINT opportunities_owner_member_fk FOREIGN KEY (organization_id, owner_id) REFERENCES memberships (organization_id, user_id);
ALTER TABLE follow_ups ADD CONSTRAINT follow_ups_assignee_member_fk FOREIGN KEY (organization_id, assigned_to_id) REFERENCES memberships (organization_id, user_id);
ALTER TABLE tasks ADD CONSTRAINT tasks_assignee_member_fk FOREIGN KEY (organization_id, assigned_to_id) REFERENCES memberships (organization_id, user_id);
ALTER TABLE notifications ADD CONSTRAINT notifications_recipient_member_fk FOREIGN KEY (organization_id, user_id) REFERENCES memberships (organization_id, user_id);
ALTER TABLE notification_preferences ADD CONSTRAINT notification_prefs_member_fk FOREIGN KEY (organization_id, user_id) REFERENCES memberships (organization_id, user_id);

-- ── State / integrity checks ────────────────────────────────────────────────
ALTER TABLE follow_ups ADD CONSTRAINT follow_ups_completed_has_outcome
  CHECK (status <> 'COMPLETED' OR (completed_at IS NOT NULL AND completed_by_id IS NOT NULL AND outcome IS NOT NULL));
ALTER TABLE follow_ups ADD CONSTRAINT follow_ups_canceled_has_timestamp CHECK (status <> 'CANCELED' OR canceled_at IS NOT NULL);
ALTER TABLE tasks ADD CONSTRAINT tasks_done_has_timestamp CHECK (status <> 'DONE' OR completed_at IS NOT NULL);
ALTER TABLE invoices ADD CONSTRAINT invoices_paid_has_timestamp CHECK (status <> 'PAID' OR paid_at IS NOT NULL);
ALTER TABLE leads ADD CONSTRAINT leads_converted_has_timestamp CHECK (status <> 'CONVERTED' OR converted_at IS NOT NULL);
ALTER TABLE leads ADD CONSTRAINT leads_lost_has_timestamp CHECK (status <> 'LOST' OR lost_at IS NOT NULL);
ALTER TABLE subscriptions ADD CONSTRAINT subscription_period_order CHECK (current_period_end >= current_period_start);
ALTER TABLE users ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email));
ALTER TABLE subscription_plans ADD CONSTRAINT plan_prices_nonneg CHECK (price_monthly >= 0 AND price_yearly >= 0 AND trial_days >= 0);

-- ── Case-insensitive uniqueness of configuration names ──────────────────────
CREATE UNIQUE INDEX pipeline_stage_name_ci ON pipeline_stages (pipeline_id, lower(name));
CREATE UNIQUE INDEX lead_source_name_ci ON lead_sources (organization_id, lower(name));
CREATE UNIQUE INDEX tag_name_ci ON tags (organization_id, lower(name));
CREATE UNIQUE INDEX lost_reason_name_ci ON lost_reasons (organization_id, lower(name));
CREATE UNIQUE INDEX lead_priority_name_ci ON lead_priorities (organization_id, lower(name));

-- ── Indexes driven by the scheduler / dashboard / report queries ────────────
CREATE INDEX leads_inactivity_scan_idx ON leads (organization_id, last_activity_at) WHERE archived_at IS NULL AND merged_into_id IS NULL;
CREATE INDEX leads_uncontacted_scan_idx ON leads (organization_id, created_at) WHERE first_contacted_at IS NULL AND archived_at IS NULL;
CREATE INDEX leads_converted_idx ON leads (organization_id, converted_at) WHERE converted_at IS NOT NULL;
CREATE INDEX opportunities_won_idx ON opportunities (organization_id, won_at) WHERE status = 'WON';
CREATE INDEX opportunities_lost_idx ON opportunities (organization_id, lost_at) WHERE status = 'LOST';
CREATE INDEX activities_type_idx ON activities (organization_id, type, occurred_at);
CREATE INDEX follow_ups_completed_idx ON follow_ups (organization_id, completed_at) WHERE status = 'COMPLETED';
CREATE INDEX tasks_open_due_idx ON tasks (organization_id, due_at) WHERE status IN ('TODO', 'IN_PROGRESS');
CREATE INDEX invoices_open_idx ON invoices (organization_id, status) WHERE status IN ('OPEN', 'FAILED');
CREATE INDEX audit_logs_action_idx ON audit_logs (organization_id, action, created_at);
