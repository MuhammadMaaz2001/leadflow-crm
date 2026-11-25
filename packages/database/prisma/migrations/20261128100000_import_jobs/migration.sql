-- Background lead imports: job state, checkpoint and row-level error report (additive). The uploaded file itself lives in the private object store.
CREATE TABLE import_jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by_id    uuid,
  kind             text        NOT NULL DEFAULT 'LEADS' CHECK (kind IN ('LEADS')),
  status           text        NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','QUEUED','RUNNING','COMPLETED','FAILED','CANCELED','EXPIRED')),
  file_name        text        NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  file_key         text,
  file_size        bigint      NOT NULL CHECK (file_size >= 0),
  file_format      text        NOT NULL CHECK (file_format IN ('csv','xlsx')),
  options          jsonb       NOT NULL DEFAULT '{}',
  headers          jsonb,
  mapping          jsonb,
  unmapped_headers jsonb,
  preview          jsonb,
  total_rows       integer,
  processed_rows   integer     NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
  created_rows     integer     NOT NULL DEFAULT 0 CHECK (created_rows >= 0),
  failed_rows      integer     NOT NULL DEFAULT 0 CHECK (failed_rows >= 0),
  skipped_rows     integer     NOT NULL DEFAULT 0 CHECK (skipped_rows >= 0),
  last_row         integer     NOT NULL DEFAULT 1 CHECK (last_row >= 1),
  automations_fired integer    NOT NULL DEFAULT 0,
  attempts         integer     NOT NULL DEFAULT 0,
  requeues         integer     NOT NULL DEFAULT 0,
  error            text,
  stop_reason      text,
  cancel_requested boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  queued_at        timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  file_deleted_at  timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_jobs_creator_fk FOREIGN KEY (organization_id, created_by_id) REFERENCES memberships (organization_id, user_id)
);
CREATE INDEX import_jobs_org_idx ON import_jobs (organization_id, created_at DESC);
CREATE INDEX import_jobs_active_idx ON import_jobs (status) WHERE status IN ('QUEUED','RUNNING');
CREATE TABLE import_job_errors (
  id              bigserial   PRIMARY KEY,
  job_id          uuid        NOT NULL REFERENCES import_jobs (id) ON DELETE CASCADE,
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  row_number      integer     NOT NULL,
  kind            text        NOT NULL CHECK (kind IN ('ERROR','DUPLICATE')),
  field           text,
  message         text        NOT NULL,
  data            jsonb,
  CONSTRAINT import_job_errors_unique UNIQUE (job_id, row_number, kind)
);
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;  ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE import_job_errors ENABLE ROW LEVEL SECURITY;  ALTER TABLE import_job_errors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_jobs USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());
CREATE POLICY tenant_isolation ON import_job_errors USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());
GRANT USAGE, SELECT ON SEQUENCE import_job_errors_id_seq TO leadflow_app;
