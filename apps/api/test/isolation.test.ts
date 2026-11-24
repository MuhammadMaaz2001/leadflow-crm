import { beforeAll, describe, expect, it } from 'vitest';
import { addDays } from 'date-fns';
import { addMember, boot, createWorkspace, makePlatformAdmin, platformPrisma, prisma, request, signUp, withOrg, app, type Actor } from './helpers';

beforeAll(boot);

describe('multi-tenant isolation', () => {
  let a: Actor, b: Actor, aAgent: Actor;
  let leadA = '', taskA = '', followA = '', oppA = '';

  beforeAll(async () => {
    a = await createWorkspace(await signUp('Alice Owner'), 'Company A');
    b = await createWorkspace(await signUp('Bob Owner'), 'Company B');
    aAgent = await addMember(a, 'SALES_AGENT');
    const lead = await a.post('/leads', { firstName: 'Secret', email: 'secret@a.example', assignedToId: a.userId });
    leadA = lead.body.data.id;
    taskA = (await a.post('/tasks', { title: 'A private task', leadId: leadA })).body.data.id;
    followA = (await a.post('/followups', { leadId: leadA, dueAt: addDays(new Date(), 1).toISOString() })).body.data.id;
    oppA = (await a.post('/opportunities', { leadId: leadA, name: 'A deal', value: 1000 })).body.data.id;
  });

  it('B cannot read, modify or archive A\'s records by id (IDOR) even using its own org header', async () => {
    for (const url of [`/leads/${leadA}`, `/tasks/${taskA}`, `/followups/${followA}`, `/opportunities/${oppA}`, `/leads/${leadA}/activities`, `/leads/${leadA}/assignments`]) {
      expect((await b.get(url)).status, url).toBe(404);
    }
    expect((await b.patch(`/leads/${leadA}`, { firstName: 'Hacked' })).status).toBe(404);
    expect((await b.post(`/leads/${leadA}/archive`)).status).toBe(404);
    expect((await b.post(`/opportunities/${oppA}/move`, { stageId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await b.post(`/followups/${followA}/cancel`, {})).status).toBe(404);
    expect((await b.patch(`/tasks/${taskA}`, { status: 'DONE' })).status).toBe(404);
    const stillThere = await a.get(`/leads/${leadA}`);
    expect(stillThere.body.data.firstName).toBe('Secret');
  });

  it('B cannot list A\'s data and A\'s data never appears in B\'s lists, reports or dashboards', async () => {
    expect((await b.get('/leads')).body.data).toHaveLength(0);
    expect((await b.get('/tasks?scope=all')).body.data).toHaveLength(0);
    expect((await b.get('/followups?view=all')).body.data).toHaveLength(0);
    expect((await b.get('/opportunities')).body.data).toHaveLength(0);
    expect((await b.get('/dashboard')).body.data.kpis.totalLeads).toBe(0);
    expect((await b.get('/reports/lead-generation?range=last_30_days')).body.data.summary[0].value).toBe(0);
    expect((await b.get('/activities')).body.data.every((x: { lead: unknown }) => x.lead === null)).toBe(true);
  });

  it('spoofing X-Org-Id with another tenant\'s id is rejected', async () => {
    const spoof = withOrg(b, a.orgId!);
    for (const url of ['/leads', '/members', '/dashboard', '/organizations/current', '/billing', '/roles']) {
      const r = await spoof.get(url);
      expect(r.status, url).toBe(403);
      expect(r.body.error.code).toBe('NOT_A_MEMBER');
    }
    expect((await spoof.post('/leads', { firstName: 'Injected', email: 'x@y.com' })).status).toBe(403);
    expect((await a.get('/leads')).body.data.map((l: { firstName: string }) => l.firstName)).not.toContain('Injected');
  });

  it('cannot reference another tenant\'s records when creating (cross-tenant foreign keys)', async () => {
    const aSources = (await a.get('/lead-sources')).body.data as Array<{ id: string }>;
    const bLead = (await b.post('/leads', { firstName: 'B lead', email: 'b@b.example' })).body.data.id;
    // lead using A's source id
    expect((await b.post('/leads', { firstName: 'X', email: 'x1@b.example', sourceId: aSources[0]!.id })).status).toBe(400);
    // tasks / follow-ups / opportunities linking A's lead
    expect((await b.post('/tasks', { title: 't', leadId: leadA })).status).toBe(404);
    expect((await b.post('/followups', { leadId: leadA, dueAt: addDays(new Date(), 1).toISOString() })).status).toBe(404);
    expect((await b.post('/opportunities', { leadId: leadA, name: 'x', value: 1 })).status).toBe(404);
    // assigning B's lead to A's user
    expect((await b.post(`/leads/${bLead}/assign`, { assignedToId: a.userId })).status).toBe(400);
    // B's opp in A's pipeline stage
    const aStage = (await a.get('/pipelines')).body.data[0].stages[0].id;
    const bOpp = await b.post('/opportunities', { leadId: bLead, name: 'b deal', value: 5 });
    expect((await b.post(`/opportunities/${bOpp.body.data.id}/move`, { stageId: aStage })).status).toBe(400);
    // bulk with a foreign id is rejected as a whole
    const bulk = await b.post('/leads/bulk', { ids: [bLead, leadA], action: 'archive' });
    expect(bulk.status).toBe(400);
    expect((await b.get(`/leads/${bLead}`)).body.data.archivedAt).toBeNull();
  });

  it('database-level: row level security hides other tenants even if the application forgot a filter', async () => {
    const orgsSeen = async (org: string) => prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${org}, true)`;
      const rows = await tx.lead.findMany({ select: { organizationId: true } }); // deliberately unscoped query
      return new Set(rows.map((r) => r.organizationId));
    });
    expect([...(await orgsSeen(a.orgId!))]).toEqual([a.orgId]);
    expect([...(await orgsSeen(b.orgId!))]).toEqual([b.orgId]);
    const total = await prisma.$transaction(async (tx) => tx.lead.count()); // no tenant context at all
    expect(total).toBe(0);
    // composite FK: a lead cannot point to another tenant's source
    const aSource = (await a.get('/lead-sources')).body.data[0].id;
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${b.orgId!}, true)`;
      await tx.lead.create({ data: { organizationId: b.orgId!, firstName: 'x', email: 'fk@x.com', sourceId: aSource } });
    })).rejects.toThrow();
    // write with a mismatching tenant context is rejected by RLS
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${b.orgId!}, true)`;
      await tx.lead.create({ data: { organizationId: a.orgId!, firstName: 'x', email: 'rls@x.com' } });
    })).rejects.toThrow();
  });

  it('platform database role cannot read private CRM tables', async () => {
    await expect(platformPrisma.lead.count()).rejects.toThrow(/permission denied/i);
    await expect(platformPrisma.activity.findMany()).rejects.toThrow(/permission denied/i);
    await expect(platformPrisma.task.findMany()).rejects.toThrow(/permission denied/i);
    expect(await platformPrisma.organization.count()).toBeGreaterThanOrEqual(2);
  });

  it('platform admin routes are separate: tenant users are refused; platform admins have no tenant access', async () => {
    expect((await a.get('/platform/dashboard')).status).toBe(403);
    const admin = await makePlatformAdmin('SUPER_ADMIN');
    expect((await admin.get('/platform/dashboard')).status).toBe(200);
    const asTenant = withOrg(admin, a.orgId!);
    expect((await asTenant.get('/leads')).status).toBe(403);
    expect((await asTenant.get(`/leads/${leadA}`)).status).toBe(403);
    const detail = await admin.get(`/platform/organizations/${a.orgId}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain('secret@a.example');
    expect(JSON.stringify(detail.body)).not.toContain('Secret');
  });

  it('removed / deactivated members lose access immediately', async () => {
    const members = (await a.get('/members')).body.data as Array<{ id: string; userId: string }>;
    const m = members.find((x) => x.userId === aAgent.userId)!;
    expect((await aAgent.get('/leads')).status).toBe(200);
    expect((await a.patch(`/members/${m.id}`, { status: 'DEACTIVATED' })).status).toBe(200);
    const r = await aAgent.get('/leads');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MEMBER_DEACTIVATED');
  });

  it('unauthenticated and malformed requests are rejected', async () => {
    expect((await request(app).get('/api/leads').set('X-Org-Id', a.orgId!)).status).toBe(401);
    expect((await a.agent.get('/api/leads')).status).toBe(400); // missing org header
    expect((await a.agent.get('/api/leads').set('X-Org-Id', 'not-a-uuid')).status).toBe(400);
    expect((await a.get('/leads/not-a-uuid')).status).toBe(404);
  });
});

describe('roles & permissions', () => {
  let owner: Actor, manager: Actor, agent: Actor, viewer: Actor;
  beforeAll(async () => {
    owner = await createWorkspace(await signUp('Perm Owner'), 'Perm Co');
    manager = await addMember(owner, 'MANAGER');
    agent = await addMember(owner, 'SALES_AGENT');
    viewer = await addMember(owner, 'VIEWER');
    await owner.post('/leads', { firstName: 'Visible', email: 'visible@perm.example' });
  });

  it('enforces permissions per role', async () => {
    expect((await agent.get('/members')).status).toBe(200); // team.view
    expect((await agent.post('/invitations', { email: 'x@y.com', roleId: '00000000-0000-4000-8000-000000000000' })).status).toBe(403);
    expect((await agent.patch('/organizations/current', { name: 'Hijack' })).status).toBe(403);
    expect((await manager.patch('/organizations/current', { name: 'Hijack' })).status).toBe(403);
    expect((await agent.post('/leads/bulk', { ids: ['00000000-0000-4000-8000-000000000000'], action: 'assign', assignedToId: agent.userId })).status).toBe(403);
    expect((await agent.get('/billing')).status).toBe(403);
    expect((await manager.get('/billing')).status).toBe(403);
    expect((await owner.get('/billing')).status).toBe(200);
    expect((await agent.get('/audit-logs')).status).toBe(403);
    expect((await viewer.post('/leads', { firstName: 'No', email: 'no@perm.example' })).status).toBe(403);
    expect((await viewer.get('/leads')).body.data).toHaveLength(1);
    expect((await agent.get('/leads')).body.data).toHaveLength(0);
    expect((await agent.get('/dashboard')).body.data.filters.restricted).toBe(true);
    expect((await viewer.get('/dashboard')).body.data.filters.restricted).toBe(false);
  });

  it('agents can only assign leads to themselves and own what they create', async () => {
    const mine = await agent.post('/leads', { firstName: 'Mine', email: 'mine@perm.example' });
    expect(mine.status).toBe(201);
    expect(mine.body.data.assignedTo.id).toBe(agent.userId);
    expect((await agent.post('/leads', { firstName: 'Other', email: 'other@perm.example', assignedToId: manager.userId })).status).toBe(403);
  });

  it('last owner is protected; custom roles require the plan feature; role editing works', async () => {
    const members = (await owner.get('/members')).body.data as Array<{ id: string; userId: string }>;
    const me = members.find((m) => m.userId === owner.userId)!;
    const deact = await owner.patch(`/members/${me.id}`, { status: 'DEACTIVATED' });
    expect(deact.status).toBe(409);
    const role = await owner.post('/roles', { name: 'Intern', permissions: ['leads.create', 'bogus.permission'] });
    expect(role.status).toBe(201); // trial = professional
    expect(role.body.data.permissions).toEqual(['leads.create']);
  });
});
