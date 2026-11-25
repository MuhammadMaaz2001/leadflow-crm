-- Large-workspace lead search (additive).
--
-- WHY: row level security makes PostgreSQL evaluate the tenant policy before any non-"leakproof" operator, and ILIKE (texticlike / textlike) is not
-- leakproof, so the pg_trgm indexes from the first migration could never be used for the app role: a rare search term scanned the whole workspace
-- (650 ms at 250k leads, see PRODUCTION_READINESS.md). The function below runs the same substring match as a SECURITY DEFINER function owned by a
-- dedicated NOLOGIN role that bypasses RLS and can read only the searchable columns of `leads`. Isolation is enforced INSIDE the function: it filters by
-- app_org_id() (the transaction's own setting — there is no organisation parameter a caller could forge) and returns nothing when no workspace is set.
-- The application then loads the matching rows through the normal RLS-protected query, so every other rule (scope, archive, filters, permissions) still applies.
CREATE INDEX IF NOT EXISTS leads_phone_norm_trgm ON leads USING gin (phone_normalized gin_trgm_ops);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadflow_search') THEN CREATE ROLE leadflow_search NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO leadflow_search;
GRANT SELECT (id, organization_id, first_name, last_name, email, company_name, phone, phone_normalized) ON leads TO leadflow_search;

-- PL/pgSQL building the statement with the search patterns inlined as quoted literals (%L): the planner then sees constant patterns and uses the
-- trigram GIN indexes. (A plain SQL function plans the pattern as a computed column, which cannot be an index condition — measured: a sequential scan.)
-- Every term must match (AND), each in any searchable column (OR) — the same semantics as the application's previous ILIKE query.
CREATE OR REPLACE FUNCTION lf_search_lead_ids(terms text[], max_rows integer)
RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
  org uuid := app_org_id();
  cond text := '';
  t text; pat text; digits text;
BEGIN
  IF org IS NULL OR terms IS NULL OR cardinality(terms) = 0 OR cardinality(terms) > 6 THEN RETURN; END IF;
  FOREACH t IN ARRAY terms LOOP
    pat := '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    digits := regexp_replace(t, '\D', '', 'g');
    cond := cond || format(' AND (l.first_name ILIKE %1$L OR l.last_name ILIKE %1$L OR l.email ILIKE %1$L OR l.company_name ILIKE %1$L OR l.phone LIKE %1$L%2$s)',
                           pat, CASE WHEN length(digits) >= 4 THEN format(' OR l.phone_normalized LIKE %L', '%' || digits || '%') ELSE '' END);
  END LOOP;
  RETURN QUERY EXECUTE format('SELECT l.id FROM leads l WHERE l.organization_id = %L::uuid%s LIMIT %s', org, cond, GREATEST(1, LEAST(max_rows, 5000)));
END
$fn$;
ALTER FUNCTION lf_search_lead_ids(text[], integer) OWNER TO leadflow_search;
REVOKE ALL ON FUNCTION lf_search_lead_ids(text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lf_search_lead_ids(text[], integer) TO leadflow_app;
