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
  const schemaCreate = (await db.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, o.appRole))[0]?.ok;
  if (app && schemaCreate) problems.push(`role ${o.appRole} can CREATE objects in schema public`);
  return problems;
}
