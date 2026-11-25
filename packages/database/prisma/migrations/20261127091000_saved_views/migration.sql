-- Server-side saved lead views (previously browser-only). Personal by default, optionally shared with the workspace. Additive.
CREATE TABLE saved_views (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL,
  name            text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  entity          text        NOT NULL DEFAULT 'LEAD' CHECK (entity IN ('LEAD')),
  query           text        NOT NULL DEFAULT '' CHECK (length(query) <= 1500),
  is_shared       boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_views_owner_fk FOREIGN KEY (organization_id, user_id) REFERENCES memberships (organization_id, user_id)
);
CREATE UNIQUE INDEX saved_views_owner_name_unique ON saved_views (organization_id, user_id, entity, lower(btrim(name)));
CREATE INDEX saved_views_shared_idx ON saved_views (organization_id, entity) WHERE is_shared;
ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_views FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saved_views USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());
