import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from 'date-fns';
import { addMember, boot, createWorkspace, ownerPrisma, prisma, signUp, type Actor } from './helpers';

beforeAll(boot);

const q = <T,>(sql: string, ...params: unknown[]) => ownerPrisma.$queryRawUnsafe<T[]>(sql, ...params);

describe('schema-level guarantees', () => {
  it('every table with organization_id has FORCED row level security and a policy', async () => {
    const rows = await q<{ table: string; rls: boolean; forced: boolean; policies: number }>(`
      SELECT c.relname AS "table", c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM information_schema.columns col WHERE col.table_name = c.relname AND col.table_schema = 'public' AND col.column_name IN ('organization_id'))`);
    expect(rows.length).toBeGreaterThan(25);
    for (const r of rows) {
      expect(r.rls, `${r.table} RLS enabled`).toBe(true);
      expect(r.forced, `${r.table} RLS forced`).toBe(true);
      expect(r.policies, `${r.table} policies`).toBeGreaterThan(0);
    }
    // and organizations itself
    const [org] = await q<{ rls: boolean; forced: boolean }>(`SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE relname = 'organizations'`);
    expect(org).toEqual({ rls: true, forced: true });
  });

  it('runtime roles are least-privilege: app role cannot bypass RLS; platform role has no grants on private CRM tables', async () => {
    const roles = await q<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('leadflow_app','leadflow_platform')`);
    const app = roles.find((r) => r.rolname === 'leadflow_app')!, plat = roles.find((r) => r.rolname === 'leadflow_platform')!;
    expect(app).toMatchObject({ rolsuper: false, rolbypassrls: false });
    expect(plat).toMatchObject({ rolsuper: false, rolbypassrls: true });
    const priv = ['leads', 'lead_assignments', 'lead_tags', 'opportunities', 'stage_history', 'follow_ups', 'follow_up_events', 'activities', 'tasks', 'task_comments', 'notifications', 'notification_preferences', 'automation_rules', 'automation_executions', 'assignment_rules', 'custom_field_defs', 'tags', 'lead_sources', 'pipelines', 'pipeline_stages', 'invitations'];
    for (const t of priv) {
      const [r] = await q<{ s: boolean; i: boolean; u: boolean; d: boolean }>(`SELECT has_table_privilege('leadflow_platform', $1, 'SELECT') s, has_table_privilege('leadflow_platform', $1, 'INSERT') i, has_table_privilege('leadflow_platform', $1, 'UPDATE') u, has_table_privilege('leadflow_platform', $1, 'DELETE') d`, t);
      expect(r, `platform role on ${t}`).toEqual({ s: false, i: false, u: false, d: false });
    }
  });

  it('history tables are append-only for the application role', async () => {
    for (const t of ['audit_logs', 'lead_assignments', 'stage_history', 'follow_up_events', 'subscription_events', 'activities']) {
      const [r] = await q<{ u: boolean; d: boolean; i: boolean }>(`SELECT has_table_privilege('leadflow_app', $1, 'UPDATE') u, has_table_privilege('leadflow_app', $1, 'DELETE') d, has_table_privilege('leadflow_app', $1, 'INSERT') i`, t);
      expect(r.i, `${t} insert`).toBe(true);
      expect(r.d, `${t} delete`).toBe(false);
      expect(r.u, `${t} update`).toBe(false);
    }
  });

  it('money is numeric and every timestamp is timezone-aware', async () => {
    const money = await q<{ table_name: string; column_name: string; data_type: string }>(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('value','amount','price_monthly','price_yearly')`);
    expect(money.length).toBeGreaterThanOrEqual(4);
    for (const m of money) expect(m.data_type, `${m.table_name}.${m.column_name}`).toBe('numeric');
    const naive = await q<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'timestamp without time zone' AND table_name <> '_prisma_migrations'`);
    expect(naive).toEqual([]);
  });

  it('every foreign key is covered by an index on its referencing columns (or is a primary-key prefix)', async () => {
    const missing = await q<{ conrelid: string; conname: string }>(`
      SELECT c.conrelid::regclass::text AS conrelid, c.conname FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND (i.indkey::int2[])[0:array_length(c.conkey,1)-1] @> c.conkey AND (i.indkey::int2[])[0:array_length(c.conkey,1)-1] <@ c.conkey)`);
    // Only reference-data FKs to the tiny global plan catalogue (never deleted) are exempt.
    for (const m of missing) expect(['invoices', 'subscriptions'].includes(m.conrelid) && m.conname.endsWith('plan_id_fkey'), `unindexed FK ${m.conrelid}.${m.conname}`).toBe(true);
  });
});

describe('tenant-aware foreign keys and integrity constraints', () => {
  let a: Actor, b: Actor, agentB: Actor;
  let leadA = '';
  beforeAll(async () => {
    a = await createWorkspace(await signUp('DB Owner A'), 'DB Co A');
    b = await createWorkspace(await signUp('DB Owner B'), 'DB Co B');
    agentB = await addMember(b, 'SALES_AGENT');
    leadA = (await a.post('/leads', { firstName: 'Fk', email: 'fk@a.test' })).body.data.id;
  });

  const asApp = <T,>(org: string, fn: (tx: typeof prisma) => Promise<T>) =>
    prisma.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.org_id', ${org}, true)`; return fn(tx as unknown as typeof prisma); });

  it('a lead cannot be assigned to a user who is not a member of its organization (even bypassing the API)', async () => {
    await expect(asApp(a.orgId!, (tx) => tx.lead.update({ where: { id: leadA }, data: { assignedToId: agentB.userId } }))).rejects.toThrow(/foreign key|violates/i);
    await expect(asApp(a.orgId!, (tx) => tx.followUp.create({ data: { organizationId: a.orgId!, leadId: leadA, dueAt: addDays(new Date(), 1), assignedToId: agentB.userId, createdById: a.userId } }))).rejects.toThrow(/foreign key|violates/i);
    await expect(asApp(a.orgId!, (tx) => tx.task.create({ data: { organizationId: a.orgId!, title: 'x', assignedToId: agentB.userId } }))).rejects.toThrow(/foreign key|violates/i);
    await expect(asApp(a.orgId!, (tx) => tx.notification.create({ data: { organizationId: a.orgId!, userId: agentB.userId, type: 'SYSTEM', title: 'leak' } }))).rejects.toThrow(/foreign key|violates/i);
    // a legitimate member works
    await asApp(a.orgId!, (tx) => tx.lead.update({ where: { id: leadA }, data: { assignedToId: a.userId } }));
  });

  it('an opportunity cannot sit in a stage of a different pipeline', async () => {
    const pipes = (await a.get('/pipelines')).body.data;
    const second = (await a.post('/pipelines', { name: 'Second' })).body.data;
    const secondStages = (await a.get('/pipelines')).body.data.find((p: { id: string }) => p.id === second.id).stages;
    const opp = (await a.post('/opportunities', { leadId: leadA, name: 'X', value: 1 })).body.data;
    await expect(asApp(a.orgId!, (tx) => tx.opportunity.update({ where: { id: opp.id }, data: { stageId: secondStages[0].id } }))).rejects.toThrow(/foreign key|violates/i);
    expect(pipes[0].id).not.toBe(second.id);
  });

  it('state checks reject impossible rows (completed follow-up without outcome, done task without timestamp, mixed-case emails, duplicate names)', async () => {
    const fu = (await a.post('/followups', { leadId: leadA, dueAt: addDays(new Date(), 2).toISOString() })).body.data.id;
    await expect(ownerPrisma.$executeRawUnsafe(`UPDATE follow_ups SET status = 'COMPLETED' WHERE id = '${fu}'`)).rejects.toThrow(/follow_ups_completed_has_outcome/);
    const task = (await a.post('/tasks', { title: 'T' })).body.data.id;
    await expect(ownerPrisma.$executeRawUnsafe(`UPDATE tasks SET status = 'DONE' WHERE id = '${task}'`)).rejects.toThrow(/tasks_done_has_timestamp/);
    await expect(ownerPrisma.$executeRawUnsafe(`UPDATE leads SET status = 'LOST' WHERE id = '${leadA}'`)).rejects.toThrow(/leads_lost_has_timestamp/);
    await expect(ownerPrisma.user.create({ data: { email: 'MixedCase@Example.com', name: 'x', passwordHash: 'x' } })).rejects.toThrow(/users_email_lowercase/);
    expect((await a.post('/tags', { name: 'Hot' })).status).toBe(201);
    expect((await a.post('/tags', { name: 'HOT' })).status).toBe(409);
    expect((await a.post('/lead-sources', { name: 'website' })).status).toBe(409); // default "Website" exists
    const stage = (await a.get('/pipelines')).body.data[0];
    expect((await a.post(`/pipelines/${stage.id}/stages`, { name: 'qualified' })).status).toBe(409);
  });

  it('cascade rules: deleting an organization removes its data but never touches another tenant', async () => {
    const victim = await createWorkspace(await signUp('Victim'), 'Cascade Co');
    const lead = (await victim.post('/leads', { firstName: 'Gone', email: 'gone@c.test' })).body.data.id;
    await victim.post('/opportunities', { leadId: lead, name: 'D', value: 5 });
    await victim.post('/followups', { leadId: lead, dueAt: addDays(new Date(), 1).toISOString() });
    const before = await q<{ n: number }>(`SELECT count(*)::int n FROM leads WHERE organization_id = '${a.orgId}'`);
    await ownerPrisma.organization.delete({ where: { id: victim.orgId! } });
    const left = await q<{ n: number }>(`SELECT (SELECT count(*) FROM leads WHERE organization_id = '${victim.orgId}')::int + (SELECT count(*) FROM opportunities WHERE organization_id = '${victim.orgId}')::int + (SELECT count(*) FROM memberships WHERE organization_id = '${victim.orgId}')::int AS n`);
    expect(left[0]!.n).toBe(0);
    expect((await q<{ n: number }>(`SELECT count(*)::int n FROM leads WHERE organization_id = '${a.orgId}'`))[0]!.n).toBe(before[0]!.n);
    expect((await q<{ n: number }>(`SELECT count(*)::int n FROM users WHERE id = '${victim.userId}'`))[0]!.n).toBe(1); // global users survive
  });

  it('lead archive keeps history; archived leads stay queryable by id for owners', async () => {
    await a.post(`/leads/${leadA}/archive`);
    expect((await a.get(`/leads/${leadA}`)).body.data.archivedAt).toBeTruthy();
    const acts = await a.get(`/leads/${leadA}/activities?pageSize=50`);
    expect(acts.body.data.length).toBeGreaterThan(1);
  });
});

describe('query efficiency at volume', () => {
  const created: string[] = [];
  // the bulk data must not slow down the scheduler in later test files
  afterAll(async () => { for (const id of created) await ownerPrisma.organization.delete({ where: { id } }).catch(() => undefined); });
  it('key list / scan queries use indexes on a 30k-lead workspace', async () => {
    const org = await createWorkspace(await signUp('Perf Owner'), 'Perf Co');
    created.push(org.orgId!);
    await ownerPrisma.$executeRawUnsafe(`
      INSERT INTO leads (id, organization_id, first_name, last_name, email, email_normalized, company_name, status, last_activity_at, created_at, updated_at)
      SELECT gen_random_uuid(), '${org.orgId}', 'First' || g, 'Last' || (g % 997), 'p' || g || '@perf.test', 'p' || g || '@perf.test', 'Company ' || (g % 313),
             'NEW', now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval, now() FROM generate_series(1, 30000) g`);
    // neighbours make the tenant filter selective, like a real multi-tenant database
    for (let i = 0; i < 3; i++) {
      const other = await createWorkspace(await signUp(`Neighbour ${i}`), `Neighbour Co ${i}`);
      created.push(other.orgId!);
      await ownerPrisma.$executeRawUnsafe(`INSERT INTO leads (id, organization_id, first_name, email, last_activity_at, updated_at) SELECT gen_random_uuid(), '${other.orgId}', 'N' || g, 'n' || g || '@nb.test', now(), now() FROM generate_series(1, 20000) g`);
    }
    await ownerPrisma.$executeRawUnsafe('ANALYZE leads');
    const explain = async (sql: string) => {
      const rows = await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.org_id', '${org.orgId}', true)`);
        await tx.$executeRawUnsafe('SET LOCAL ROLE leadflow_app');
        return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN ${sql}`);
      });
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    };
    const list = await explain(`SELECT * FROM leads WHERE organization_id = '${org.orgId}' AND archived_at IS NULL AND merged_into_id IS NULL ORDER BY created_at DESC LIMIT 25`);
    expect(list).toMatch(/Index/);
    expect(list).not.toMatch(/Sort\b.*\n.*Seq Scan/s);
    // Under RLS the planner (correctly) keeps the non-leakproof ILIKE behind the tenant qual, so the tenant index is used.
    const search = await explain(`SELECT * FROM leads WHERE organization_id = '${org.orgId}' AND email ILIKE '%p29999@%' LIMIT 25`);
    expect(search).toMatch(/Index|Bitmap/);
    const scan = await explain(`SELECT id FROM leads WHERE organization_id = '${org.orgId}' AND archived_at IS NULL AND merged_into_id IS NULL AND last_activity_at <= now() - interval '20 days' LIMIT 200`);
    expect(scan).toMatch(/Index/);
    // end-to-end latency on the real endpoints
    const timed = async (label: string, fn: () => Promise<{ status: number }>, budgetMs: number) => {
      const t0 = Date.now(); const r = await fn(); const ms = Date.now() - t0;
      expect(r.status, label).toBe(200);
      expect(ms, `${label} took ${ms}ms`).toBeLessThan(budgetMs);
    };
    await timed('lead list', () => org.get('/leads?pageSize=25'), 1500);
    await timed('lead search', () => org.get('/leads?q=Company%2012&pageSize=25&sort=name'), 2000);
    await timed('dashboard (all time)', () => org.get('/dashboard?range=all'), 4000);
    await timed('lead-source report', () => org.get('/reports/lead-source?range=all'), 3000);
    await timed('follow-up summary', () => org.get('/followups/summary'), 1000);
  });
});
