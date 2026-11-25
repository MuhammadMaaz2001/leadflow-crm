-- Indexes covering the foreign keys of the tables added in this release (tenant-aware FKs are checked on every parent delete / update).
CREATE INDEX IF NOT EXISTS import_jobs_creator_idx ON import_jobs (organization_id, created_by_id);
CREATE INDEX IF NOT EXISTS lead_attachments_lead_fk_idx ON lead_attachments (lead_id, organization_id);
CREATE INDEX IF NOT EXISTS lead_attachments_org_idx ON lead_attachments (organization_id);
CREATE INDEX IF NOT EXISTS import_job_errors_org_idx ON import_job_errors (organization_id);
CREATE INDEX IF NOT EXISTS sso_connections_jit_role_idx ON sso_connections (jit_role_id, organization_id);
CREATE INDEX IF NOT EXISTS sso_identities_org_idx ON sso_identities (organization_id);
