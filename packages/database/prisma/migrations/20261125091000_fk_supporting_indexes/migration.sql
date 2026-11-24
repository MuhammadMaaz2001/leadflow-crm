-- Supporting indexes for tenant-aware foreign keys (fast parent lookups / restricts and join paths).
CREATE INDEX follow_ups_opportunity_idx ON follow_ups (organization_id, opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE INDEX tasks_opportunity_idx ON tasks (organization_id, opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE INDEX opportunities_stage_idx ON opportunities (organization_id, stage_id);
CREATE INDEX opportunities_lost_reason_idx ON opportunities (organization_id, lost_reason_id) WHERE lost_reason_id IS NOT NULL;
CREATE INDEX leads_priority_idx ON leads (organization_id, priority_id) WHERE priority_id IS NOT NULL;
CREATE INDEX leads_lost_reason_idx ON leads (organization_id, lost_reason_id) WHERE lost_reason_id IS NOT NULL;
CREATE INDEX stage_history_to_stage_idx ON stage_history (organization_id, to_stage_id);
CREATE INDEX stage_history_from_stage_idx ON stage_history (organization_id, from_stage_id) WHERE from_stage_id IS NOT NULL;
CREATE INDEX memberships_role_idx ON memberships (organization_id, role_id);
CREATE INDEX invitations_role_idx ON invitations (organization_id, role_id);
CREATE INDEX automation_executions_rule_idx ON automation_executions (organization_id, rule_id);
CREATE INDEX lead_tags_lead_idx ON lead_tags (organization_id, lead_id);
