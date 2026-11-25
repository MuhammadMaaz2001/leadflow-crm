-- Lead file attachments. Metadata lives in PostgreSQL; the bytes live in the private object store (never in the database). Additive.
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ATTACHMENT_ADDED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ATTACHMENT_REMOVED';

CREATE TABLE lead_attachments (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  lead_id            uuid        NOT NULL,
  storage_key        text        NOT NULL,
  original_name      text        NOT NULL CHECK (length(btrim(original_name)) BETWEEN 1 AND 200),
  content_type       text        NOT NULL,
  extension          text        NOT NULL CHECK (extension IN ('pdf','doc','docx','xls','xlsx','csv','jpg','png','webp')),
  size_bytes         bigint      NOT NULL CHECK (size_bytes > 0),
  sha256             text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by_id     uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  deleted_by_id      uuid,
  storage_deleted_at timestamptz,
  CONSTRAINT lead_attachments_lead_fk FOREIGN KEY (lead_id, organization_id) REFERENCES leads (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT lead_attachments_key_prefix CHECK (storage_key LIKE 'attachments/' || organization_id::text || '/%' AND storage_key !~ '\.\.')
);
CREATE UNIQUE INDEX lead_attachments_storage_key_unique ON lead_attachments (storage_key);
CREATE INDEX lead_attachments_lead_idx ON lead_attachments (organization_id, lead_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX lead_attachments_pending_delete_idx ON lead_attachments (deleted_at) WHERE deleted_at IS NOT NULL AND storage_deleted_at IS NULL;
ALTER TABLE lead_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_attachments USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());
-- lead merge re-points attachments to the surviving lead (same grant pattern as activities)
