/**
 * Verifies the security posture of a live database (run it after every deploy: `npm run db:verify`).
 * It checks facts in the catalogue, not application behaviour:
 *   • every table with an `organization_id` column has row level security ENABLED and FORCED and at least one policy,
 *   • the runtime role is neither superuser nor BYPASSRLS and cannot create objects / roles,
 *   • the platform role has no SELECT on private CRM tables,
 *   • history tables are append-only for the application role.
 */
export interface Queryable { $queryRawUnsafe: <T = unknown>(sql: string, ...v: unknown[]) => Promise<T> }
export interface VerifyOptions { appRole: string; platformRole: string }

const PRIVATE_TABLES = ['leads', 'opportunities', 'follow_ups', 'tasks', 'activities', 'notifications', 'outbound_emails', 'lead_assignments'];
const APPEND_ONLY = ['activities', 'audit_logs'];
/** Written only by the platform role (billing records): the tenant application role must have no write privilege at all. */
const READ_ONLY_FOR_APP = ['payments'];

export async function verifyDatabaseSecurity(db: Queryable, o: VerifyOptions): Promise<string[]> {
  const problems: string[] = [];
  const tenantTables = await db.$queryRawUnsafe<Array<{ t: string; rls: boolean; forced: boolean; policies: number }>>(`
    SELECT c.relname::text AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)`);
  if (tenantTables.length === 0) problems.push('no tenant tables found: is this the right database / are migrations applied?');
  for (const t of tenantTables) {
    if (!t.rls) problems.push(`table ${t.t}: row level security is not enabled`);
    else if (!t.forced) problems.push(`table ${t.t}: row level security is not FORCED (table owner would bypass it)`);
    if (t.policies === 0) problems.push(`table ${t.t}: no row level security policy`);
  }
  const roles = await db.$queryRawUnsafe<Array<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>>(
    `SELECT rolname::text, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = ANY($1::text[])`, [o.appRole, o.platformRole]);
  const app = roles.find((r) => r.rolname === o.appRole), plat = roles.find((r) => r.rolname === o.platformRole);
  if (!app) problems.push(`role ${o.appRole} does not exist`);
  else {
    if (app.rolsuper) problems.push(`role ${o.appRole} is a superuser`);
    if (app.rolbypassrls) problems.push(`role ${o.appRole} has BYPASSRLS`);
    if (app.rolcreaterole || app.rolcreatedb) problems.push(`role ${o.appRole} can create roles/databases`);
  }
  if (!plat) problems.push(`role ${o.platformRole} does not exist`);
  else if (plat.rolsuper) problems.push(`role ${o.platformRole} is a superuser`);
  const priv = async (role: string, table: string, p: string) => (await db.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT has_table_privilege($1, $2, $3) AS ok`, role, `public.${table}`, p))[0]?.ok === true;
  for (const t of PRIVATE_TABLES) if (plat && (await priv(o.platformRole, t, 'SELECT'))) problems.push(`role ${o.platformRole} can SELECT private table ${t}`);
  for (const t of APPEND_ONLY) {
    if (app && (await priv(o.appRole, t, 'DELETE'))) problems.push(`role ${o.appRole} can DELETE from append-only table ${t}`);
  }
  for (const t of READ_ONLY_FOR_APP) for (const p of ['INSERT', 'UPDATE', 'DELETE']) if (app && (await priv(o.appRole, t, p))) problems.push(`role ${o.appRole} can ${p} on billing table ${t}`);
  // lead search: the SECURITY DEFINER function bypasses RLS by design, so its shape is part of the security posture
  const fn = (await db.$queryRawUnsafe<Array<{ owner: string; definer: boolean; pub: boolean; platform: boolean; app: boolean }>>(
    `SELECT pg_get_userbyid(p.proowner)::text AS owner, p.prosecdef AS definer, has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
            has_function_privilege($1, p.oid, 'EXECUTE') AS platform, has_function_privilege($2, p.oid, 'EXECUTE') AS app
     FROM pg_proc p WHERE p.proname = 'lf_search_lead_ids' AND pg_function_is_visible(p.oid)`, o.platformRole, o.appRole))[0];
  if (!fn) problems.push('function lf_search_lead_ids is missing (migration lead_search not applied)');
  else {
    if (fn.owner !== 'leadflow_search' || !fn.definer) problems.push(`lf_search_lead_ids must be SECURITY DEFINER owned by leadflow_search (is ${fn.owner}, definer=${fn.definer})`);
    if (fn.pub) problems.push('lf_search_lead_ids is executable by PUBLIC');
    if (fn.platform) problems.push(`role ${o.platformRole} can execute lf_search_lead_ids`);
    if (!fn.app) problems.push(`role ${o.appRole} cannot execute lf_search_lead_ids`);
  }
  const sr = (await db.$queryRawUnsafe<Array<{ login: boolean; super: boolean }>>(`SELECT rolcanlogin AS login, rolsuper AS super FROM pg_roles WHERE rolname = 'leadflow_search'`))[0];
  if (sr?.login || sr?.super) problems.push('role leadflow_search must be NOLOGIN and not a superuser');
  const searchGrants = await db.$queryRawUnsafe<Array<{ t: string }>>(`SELECT DISTINCT table_name::text AS t FROM information_schema.role_table_grants WHERE grantee = 'leadflow_search' AND table_schema = 'public'`);
  const colGrants = await db.$queryRawUnsafe<Array<{ t: string }>>(`SELECT DISTINCT table_name::text AS t FROM information_schema.column_privileges WHERE grantee = 'leadflow_search' AND table_schema = 'public'`);
  for (const g of [...searchGrants, ...colGrants]) if (g.t !== 'leads') problems.push(`role leadflow_search has privileges on ${g.t}`);
  if (searchGrants.some((g) => g.t === 'leads')) problems.push('role leadflow_search has table-wide privileges on leads (column grants only)');
  const schemaCreate = (await db.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, o.appRole))[0]?.ok;
  if (app && schemaCreate) problems.push(`role ${o.appRole} can CREATE objects in schema public`);
  return problems;
}
