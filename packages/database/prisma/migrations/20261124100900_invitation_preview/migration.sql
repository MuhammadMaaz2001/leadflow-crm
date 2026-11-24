-- Public invitation preview: exposes only the minimal fields needed to render the accept page,
-- looked up by the secret token hash (never enumerable).
CREATE OR REPLACE FUNCTION invitation_preview(p_token_hash text)
RETURNS TABLE(email text, status "InvitationStatus", expires_at timestamptz, organization_name text, role_name text, invited_by text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.email, i.status, i.expires_at, o.name, r.name, u.name
  FROM invitations i
  JOIN organizations o ON o.id = i.organization_id
  JOIN roles r ON r.id = i.role_id AND r.organization_id = i.organization_id
  LEFT JOIN users u ON u.id = i.invited_by_id
  WHERE i.token_hash = p_token_hash
$$;
GRANT EXECUTE ON FUNCTION invitation_preview(text) TO leadflow_app;
