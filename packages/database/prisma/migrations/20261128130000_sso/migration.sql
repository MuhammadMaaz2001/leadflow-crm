-- Single sign-on (OpenID Connect, per workspace). Additive. Secrets are stored ENCRYPTED by the application (AES-256-GCM); tokens are never stored.
ALTER TABLE organizations ADD COLUMN sso_enforced boolean NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN auth_method text NOT NULL DEFAULT 'PASSWORD' CHECK (auth_method IN ('PASSWORD', 'SSO'));
ALTER TABLE sessions ADD COLUMN sso_org_id uuid;

CREATE TABLE sso_connections (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid        NOT NULL UNIQUE REFERENCES organizations (id) ON DELETE CASCADE,
  protocol              text        NOT NULL DEFAULT 'OIDC' CHECK (protocol IN ('OIDC')),
  name                  text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  issuer                text        NOT NULL CHECK (issuer ~ '^https?://[^\s/?#]+' AND length(issuer) <= 300),
  client_id             text        NOT NULL CHECK (length(client_id) BETWEEN 1 AND 300),
  client_secret_enc     text        NOT NULL,
  scopes                text        NOT NULL DEFAULT 'openid email profile' CHECK (length(scopes) <= 200),
  allowed_email_domains text[]      NOT NULL DEFAULT '{}',
  allow_unverified_email boolean    NOT NULL DEFAULT false,
  jit_enabled           boolean     NOT NULL DEFAULT false,
  jit_role_id           uuid,
  enabled               boolean     NOT NULL DEFAULT false,
  enforce_sso           boolean     NOT NULL DEFAULT false,
  verified_at           timestamptz,
  last_login_at         timestamptz,
  last_error            text,
  last_error_at         timestamptz,
  created_by_id         uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sso_enforce_requires_enabled CHECK (NOT enforce_sso OR enabled),
  CONSTRAINT sso_enabled_requires_domains CHECK (NOT enabled OR cardinality(allowed_email_domains) > 0),
  CONSTRAINT sso_jit_requires_role CHECK (NOT jit_enabled OR jit_role_id IS NOT NULL),
  CONSTRAINT sso_jit_role_fk FOREIGN KEY (jit_role_id, organization_id) REFERENCES roles (id, organization_id)
);
CREATE TABLE sso_identities (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL,
  issuer          text        NOT NULL,
  subject         text        NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  email           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz,
  CONSTRAINT sso_identities_subject_unique UNIQUE (organization_id, issuer, subject),
  CONSTRAINT sso_identities_user_unique UNIQUE (organization_id, user_id),
  CONSTRAINT sso_identities_member_fk FOREIGN KEY (organization_id, user_id) REFERENCES memberships (organization_id, user_id) ON DELETE CASCADE
);
ALTER TABLE sso_connections ENABLE ROW LEVEL SECURITY;  ALTER TABLE sso_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE sso_identities ENABLE ROW LEVEL SECURITY;   ALTER TABLE sso_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sso_connections USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());
CREATE POLICY tenant_isolation ON sso_identities USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());

-- The browser starts a sign-in knowing only the workspace slug. This resolver (owned by the platform role, which can read organisations) answers
-- "which workspace id, if it has SSO switched on" and nothing else — so an unknown slug and a workspace without SSO look the same.
GRANT SELECT (id, organization_id, enabled) ON sso_connections TO leadflow_platform;
CREATE FUNCTION sso_resolve_org(p_slug text) RETURNS TABLE (org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT o.id FROM organizations o JOIN sso_connections c ON c.organization_id = o.id WHERE o.slug = lower(p_slug) AND c.enabled AND o.status = 'ACTIVE' $$;
ALTER FUNCTION sso_resolve_org(text) OWNER TO leadflow_platform;
REVOKE ALL ON FUNCTION sso_resolve_org(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sso_resolve_org(text) TO leadflow_app;
