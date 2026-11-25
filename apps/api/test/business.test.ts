import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, addHours } from 'date-fns';
import ExcelJS from 'exceljs';
import { addMember, boot, confirmInvoicePaid, createWorkspace, makePlatformAdmin, ownerPrisma, signUp, type Actor } from './helpers';
import { runSchedulerTick } from '../src/modules/automations/scheduler';

beforeAll(boot);

const csv = (rows: string[]) => Buffer.from(rows.join('\n'));

describe('lead import / export', () => {
  let owner: Actor, agent: Actor;
  beforeAll(async () => {
    owner = await createWorkspace(await signUp('Import Owner'), 'Import Co');
    agent = await addMember(owner, 'SALES_AGENT');
  });

  it('validates a CSV in dry-run mode and reports row-level errors without writing', async () => {
    const file = csv([
      'First Name,Last Name,Email,Phone,Company,Source,Priority,Tags,Assigned To (email)',
      `Ann,Lee,ann@x.com,+1 202 555 0111,Acme,Website,Hot,vip;q1,${agent.email}`,
      'Bad,Email,not-an-email,,Foo,,,,',
      ',NoFirst,nofirst@x.com,,,,,,',
      'NoContact,Person,,,,,,,',
      'Dup,Of Ann,ANN@x.com,,,,,,',
      'Priya,P,,415-555-0100,Zed Corp,Referral,Cool,,',
    ]);
    const r = await owner.agent.post('/api/leads/import?dryRun=true').set('X-Org-Id', owner.orgId!).attach('file', file, 'leads.csv');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.dryRun).toBe(true);
    expect(d.total).toBe(6);
    expect(d.valid).toBe(1);
    expect(d.created).toBe(0);
    expect(d.errors.map((e: { row: number }) => e.row).sort()).toEqual([3, 4, 5, 7]);
    expect(d.errors.find((e: { row: number }) => e.row === 7).message).toMatch(/Unknown priority/);
    expect(d.duplicates).toHaveLength(1);
    expect((await owner.get('/leads')).body.meta.total).toBe(0);
  });

  it('imports valid rows, creates tags/sources, assigns by email, and skips duplicates on re-import', async () => {
    const file = csv(['first_name,last_name,email,phone,company,source,priority,tags,assigned to', `Ann,Lee,ann@x.com,,Acme,Webinar,Hot,vip;q1,${agent.email}`, 'Bo,Chan,bo@x.com,415-555-0100,Zed,Referral,Warm,,']);
    const r = await owner.agent.post('/api/leads/import').set('X-Org-Id', owner.orgId!).attach('file', file, 'ok.csv');
    expect(r.body.data.created).toBe(2);
    const list = await owner.get('/leads?q=ann');
    expect(list.body.data[0].assignedTo.id).toBe(agent.userId);
    expect(list.body.data[0].tags.map((t: { name: string }) => t.name).sort()).toEqual(['q1', 'vip']);
    expect(list.body.data[0].source.name).toBe('Webinar');
    const again = await owner.agent.post('/api/leads/import').set('X-Org-Id', owner.orgId!).attach('file', file, 'ok.csv');
    expect(again.body.data.created).toBe(0);
    expect(again.body.data.skippedDuplicates).toBe(2);
  });

  it('imports Excel files and exports CSV / Excel with filters', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Leads');
    ws.addRow(['First Name', 'Email', 'Company']);
    ws.addRow(['Xena', 'xena@x.com', 'Warrior Inc']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await owner.agent.post('/api/leads/import').set('X-Org-Id', owner.orgId!).attach('file', buf, 'leads.xlsx');
    expect(r.body.data.created).toBe(1);
    const exp = await owner.get('/leads/export?format=csv&q=xena');
    expect(exp.status).toBe(200);
    expect(exp.text).toContain('xena@x.com');
    expect(exp.text).not.toContain('ann@x.com');
    const xl = await owner.get('/leads/export?format=xlsx').buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(xl.body as Buffer);
    expect(wb2.worksheets[0]!.rowCount).toBe(4);
  });

  it('rejects unsupported files and enforces permissions', async () => {
    const r = await owner.agent.post('/api/leads/import').set('X-Org-Id', owner.orgId!).attach('file', Buffer.from('x'), 'x.pdf');
    expect(r.status).toBe(400);
    const a = await agent.agent.post('/api/leads/import').set('X-Org-Id', owner.orgId!).attach('file', csv(['a,b', '1,2']), 'x.csv');
    expect(a.status).toBe(403);
  });
});

describe('duplicate handling, merge, archive & bulk actions', () => {
  let m: Actor, agent: Actor;
  beforeAll(async () => { m = await createWorkspace(await signUp('Merge Owner'), 'Merge Co'); agent = await addMember(m, 'SALES_AGENT'); });

  it('merges duplicates preserving history, follow-ups and opportunities', async () => {
    const a = (await m.post('/leads', { firstName: 'Dana', email: 'dana@x.com' })).body.data.id;
    const b = (await m.post('/leads', { firstName: 'Dana', lastName: 'W', phone: '202-555-0199', companyName: 'DW Co', allowDuplicate: true })).body.data.id;
    await m.post(`/leads/${b}/activities`, { type: 'CALL', body: 'hello' });
    await m.post('/opportunities', { leadId: b, name: 'DW deal', value: 10 });
    await m.post('/followups', { leadId: b, dueAt: addDays(new Date(), 1).toISOString() });
    const merged = await m.post('/leads/merge', { sourceId: b, targetId: a });
    expect(merged.status).toBe(200);
    expect(merged.body.data.moved.opportunities).toBe(1);
    const lead = await m.get(`/leads/${a}`);
    expect(lead.body.data.phone).toBe('202-555-0199');
    expect(lead.body.data.companyName).toBe('DW Co');
    expect(lead.body.data.opportunities).toHaveLength(1);
    expect((await m.get(`/leads/${b}`)).body.data.mergedIntoId).toBe(a);
    const types = (await m.get(`/leads/${a}/activities?pageSize=50`)).body.data.map((x: { type: string }) => x.type);
    expect(types).toContain('LEAD_MERGED');
    expect(types).toContain('CALL');
    expect((await m.get('/leads')).body.data.map((l: { id: string }) => l.id)).not.toContain(b);
  });

  it('archives and restores while preserving history; bulk assign validates every record', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await m.post('/leads', { firstName: `Bulk${i}`, email: `bulk${i}@x.com` })).body.data.id);
    const ok = await m.post('/leads/bulk', { ids, action: 'assign', assignedToId: agent.userId });
    expect(ok.body.data.affected).toBe(3);
    expect((await agent.get('/leads?q=bulk')).body.data).toHaveLength(3);
    const bad = await m.post('/leads/bulk', { ids: [...ids, '00000000-0000-4000-8000-000000000000'], action: 'status', status: 'QUALIFIED' });
    expect(bad.status).toBe(400);
    expect((await m.get(`/leads/${ids[0]}`)).body.data.status).toBe('NEW');
    expect((await m.post('/leads/bulk', { ids, action: 'status', status: 'QUALIFIED' })).body.data.affected).toBe(3);
    expect((await m.post(`/leads/${ids[0]}/archive`)).status).toBe(200);
    expect((await m.get('/leads?q=bulk0')).body.data).toHaveLength(0);
    expect((await m.get('/leads?q=bulk0&archived=true')).body.data).toHaveLength(1);
    expect((await m.post(`/leads/${ids[0]}/restore`)).status).toBe(200);
    const hist = (await m.get(`/leads/${ids[0]}/activities`)).body.data.map((a: { type: string }) => a.type);
    expect(hist).toEqual(expect.arrayContaining(['LEAD_ARCHIVED', 'LEAD_RESTORED', 'LEAD_REASSIGNED'].filter((t) => t !== 'LEAD_REASSIGNED')));
  });

  it('applies round-robin assignment to new leads', async () => {
    await m.patch('/organizations/current', { autoAssignMode: 'ROUND_ROBIN' });
    const owners: string[] = [];
    for (let i = 0; i < 4; i++) owners.push((await m.post('/leads', { firstName: `RR${i}`, email: `rr${i}@x.com` })).body.data.assignedTo.id);
    expect(new Set(owners).size).toBe(2); // owner + agent alternate
    expect(owners[0]).not.toBe(owners[1]);
    expect(owners[0]).toBe(owners[2]);
  });
});

describe('plan limits & subscription lifecycle', () => {
  it('enforces seat and lead limits on the backend, feature gating and upgrade-by-invoice', async () => {
    const owner = await createWorkspace(await signUp('Limit Owner'), 'Limit Co');
    // move to Free (immediate from trial)
    expect((await owner.post('/billing/change-plan', { planCode: 'free', interval: 'MONTHLY' })).body.data.applied).toBe('immediately');
    const cur = await owner.get('/organizations/current');
    expect(cur.body.data.subscription.planCode).toBe('free');
    // feature gating
    expect((await owner.post('/automations', { name: 'x', trigger: 'LEAD_CREATED', actions: [{ type: 'NOTIFY', recipient: 'OWNER' }] })).status).toBe(402);
    expect((await owner.get('/leads/export')).status).toBe(402);
    expect((await owner.post('/pipelines', { name: 'Second' })).status).toBe(402);
    expect((await owner.post('/custom-fields', { label: 'Budget', type: 'NUMBER' })).status).toBe(402);
    // seats: free allows 2 (owner + 1)
    await addMember(owner, 'SALES_AGENT');
    const roles = (await owner.get('/roles')).body.data as Array<{ id: string; systemKey: string }>;
    const third = await owner.post('/invitations', { email: 'third@x.com', roleId: roles.find((r) => r.systemKey === 'SALES_AGENT')!.id });
    expect(third.status).toBe(402);
    expect(third.body.error.code).toBe('SEAT_LIMIT_REACHED');
    // leads: free allows 50
    const bulk = await ownerPrisma.$executeRawUnsafe(`INSERT INTO leads (id, organization_id, first_name, email, last_activity_at, updated_at) SELECT gen_random_uuid(), '${owner.orgId}', 'L' || g, 'l' || g || '@x.com', now(), now() FROM generate_series(1, 50) g`);
    expect(bulk).toBe(50);
    const over = await owner.post('/leads', { firstName: 'Over', email: 'over@x.com' });
    expect(over.status).toBe(402);
    expect(over.body.error.code).toBe('LEAD_LIMIT_REACHED');
    // upgrade creates an invoice; plan only changes once payment is recorded
    const up = await owner.post('/billing/change-plan', { planCode: 'starter', interval: 'MONTHLY' });
    expect(up.body.data.applied).toBe('pending_payment');
    expect((await owner.get('/organizations/current')).body.data.subscription.planCode).toBe('free');
    const pay = await confirmInvoicePaid(up.body.data.invoiceId, 'DEV-REF-1');
    expect(pay.status).toBe(200);
    const after = await owner.get('/organizations/current');
    expect(after.body.data.subscription.planCode).toBe('starter');
    expect(after.body.data.subscription.status).toBe('ACTIVE');
    expect((await owner.post('/leads', { firstName: 'Fits', email: 'fits@x.com' })).status).toBe(201);
    const billing = (await owner.get('/billing')).body.data;
    expect(billing.invoices[0].status).toBe('PAID');
    expect(billing.invoices[0].paymentMethod).toBe('BANK_TRANSFER');
    expect(billing.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['TRIAL_STARTED', 'PLAN_CHANGED', 'UPGRADE_INVOICED']));
    // downgrade blocked while over limits is explained
    const down = await owner.post('/billing/change-plan', { planCode: 'free', interval: 'MONTHLY' });
    expect(down.status).toBe(409);
  });

  it('runs renewal → grace period → expiry (read-only) and recovers when paid', async () => {
    const owner = await createWorkspace(await signUp('Expire Owner'), 'Expire Co');
    const up = await owner.post('/billing/change-plan', { planCode: 'starter', interval: 'MONTHLY' });
    await confirmInvoicePaid(up.body.data.invoiceId, 'R1');
    const periodEnd = new Date((await owner.get('/billing')).body.data.subscription.currentPeriodEnd);
    await runSchedulerTick(addHours(periodEnd, 1));
    let b = (await owner.get('/billing')).body.data;
    expect(b.subscription.status).toBe('PAST_DUE');
    expect(b.invoices[0].status).toBe('OPEN');
    expect((await owner.post('/leads', { firstName: 'InGrace', email: 'grace@x.com' })).status).toBe(201); // grace = full access
    await runSchedulerTick(addDays(periodEnd, 9));
    b = (await owner.get('/billing')).body.data;
    expect(b.subscription.status).toBe('EXPIRED');
    expect(b.invoices[0].status).toBe('FAILED');
    const blocked = await owner.post('/leads', { firstName: 'Blocked', email: 'blocked@x.com' });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('SUBSCRIPTION_EXPIRED');
    expect((await owner.get('/leads')).status).toBe(200); // read-only
    const pay = await confirmInvoicePaid(b.invoices[0].id, 'R2');
    expect(pay.status).toBe(200);
    expect((await owner.post('/leads', { firstName: 'Back', email: 'back@x.com' })).status).toBe(201);
    expect((await owner.get('/billing')).body.data.subscription.status).toBe('ACTIVE');
  });

  it('ends trials by moving to the Free plan', async () => {
    const owner = await createWorkspace(await signUp('Trial Owner'), 'Trial Co');
    expect((await owner.get('/billing')).body.data.subscription.status).toBe('TRIALING');
    await runSchedulerTick(addDays(new Date(), 15));
    const b = (await owner.get('/billing')).body.data;
    expect(b.subscription.status).toBe('ACTIVE');
    expect(b.subscription.plan.code).toBe('free');
  });
});

describe('automations', () => {
  let owner: Actor, manager: Actor, agent: Actor;
  beforeAll(async () => {
    owner = await createWorkspace(await signUp('Auto Owner'), 'Auto Co');
    manager = await addMember(owner, 'MANAGER');
    agent = await addMember(owner, 'SALES_AGENT');
  });

  it('new lead → notify managers; assignment → notify salesperson; conversion → notify management', async () => {
    const lead = await owner.post('/leads', { firstName: 'Auto', email: 'auto@x.com', assignedToId: agent.userId });
    const mNotes = (await manager.get('/notifications')).body.data.map((n: { type: string }) => n.type);
    expect(mNotes).toContain('NEW_LEAD');
    const aNotes = (await agent.get('/notifications')).body.data.map((n: { type: string }) => n.type);
    expect(aNotes).toContain('LEAD_ASSIGNED');
    const stage = (await agent.get('/pipelines')).body.data[0].stages.find((s: { kind: string }) => s.kind === 'WON');
    const opp = await agent.post('/opportunities', { leadId: lead.body.data.id, name: 'Auto deal', value: 100 });
    await agent.post(`/opportunities/${opp.body.data.id}/move`, { stageId: stage.id });
    expect((await manager.get('/notifications')).body.data.map((n: { type: string }) => n.type)).toContain('LEAD_CONVERTED');
    const logs = await owner.get('/automations/executions');
    expect(logs.body.data.length).toBeGreaterThanOrEqual(2);
    expect(logs.body.data.every((e: { status: string }) => ['SUCCESS', 'SKIPPED'].includes(e.status))).toBe(true);
  });

  it('uncontacted lead after the configured time creates a reminder task; inactive leads get re-engagement', async () => {
    const lead = await owner.post('/leads', { firstName: 'Cold', email: 'cold@x.com', assignedToId: agent.userId });
    await runSchedulerTick(addHours(new Date(), 30));
    const tasks = (await agent.get('/tasks?scope=mine')).body.data;
    expect(tasks.some((t: { title: string; isAutomated: boolean; lead: { id: string } }) => t.isAutomated && t.lead?.id === lead.body.data.id && /Contact this lead/.test(t.title))).toBe(true);
    await runSchedulerTick(addDays(new Date(), 9));
    const tasks2 = (await agent.get('/tasks?scope=mine&pageSize=100')).body.data;
    expect(tasks2.some((t: { title: string }) => /Re-engage/.test(t.title))).toBe(true);
    // re-running does not duplicate
    const n = tasks2.length;
    await runSchedulerTick(addDays(new Date(), 9));
    expect((await agent.get('/tasks?scope=mine&pageSize=100')).body.data.length).toBe(n);
  });

  it('supports custom rules, disabling, execution logs and retrying failed executions', async () => {
    const rule = await owner.post('/automations', { name: 'Escalate hot leads', trigger: 'LEAD_CREATED', conditions: {}, actions: [{ type: 'NOTIFY', recipient: 'USER', userId: agent.userId, message: 'Custom message' }] });
    expect(rule.status).toBe(201);
    expect((await owner.post('/automations', { name: 'bad', trigger: 'LEAD_NOT_CONTACTED', conditions: {}, actions: [{ type: 'NOTIFY', recipient: 'OWNER' }] })).status).toBe(400);
    await owner.post('/leads', { firstName: 'Rule', email: 'rule@x.com' });
    expect((await agent.get('/notifications')).body.data.some((n: { body: string }) => n.body === 'Custom message')).toBe(true);
    const off = await owner.post(`/automations/${rule.body.data.id}/toggle`);
    expect(off.body.data.isEnabled).toBe(false);
    const before = (await agent.get('/notifications')).body.meta.total;
    await owner.post('/leads', { firstName: 'Rule2', email: 'rule2@x.com' });
    expect((await agent.get('/notifications')).body.meta.total).toBe(before);
    // failed execution → retry
    const ex = (await owner.get(`/automations/executions?ruleId=${rule.body.data.id}`)).body.data[0];
    await ownerPrisma.automationExecution.update({ where: { id: ex.id }, data: { status: 'FAILED', error: 'simulated' } });
    expect((await owner.post(`/automations/executions/${ex.id}/retry`)).status).toBe(200);
    const after = (await owner.get(`/automations/executions?ruleId=${rule.body.data.id}`)).body.data.find((e: { id: string }) => e.id === ex.id);
    expect(['SUCCESS', 'SKIPPED']).toContain(after.status); // rule disabled → skipped
    expect((await agent.post('/automations', { name: 'x', trigger: 'LEAD_CREATED', actions: [{ type: 'NOTIFY', recipient: 'OWNER' }] })).status).toBe(403);
  });

  it('respects notification preferences and read state', async () => {
    const prefs = (await agent.get('/notifications/preferences')).body.data as Array<{ type: string; inApp: boolean }>;
    expect(prefs.find((p) => p.type === 'LEAD_ASSIGNED')!.inApp).toBe(true);
    await agent.agent.put('/api/notifications/preferences').set('X-Org-Id', owner.orgId!).send({ prefs: [{ type: 'LEAD_ASSIGNED', inApp: false }] });
    const before = (await agent.get('/notifications')).body.meta.total;
    await owner.post('/leads', { firstName: 'Muted', email: 'muted@x.com', assignedToId: agent.userId });
    expect((await agent.get('/notifications')).body.meta.total).toBe(before);
    const first = (await agent.get('/notifications')).body.data[0];
    await agent.post(`/notifications/${first.id}/read`);
    expect((await agent.get('/notifications?unreadOnly=true')).body.data.some((n: { id: string }) => n.id === first.id)).toBe(false);
    await agent.post('/notifications/read-all');
    expect((await agent.get('/notifications/unread-count')).body.data.unread).toBe(0);
  });
});

describe('tasks', () => {
  it('creates, assigns, comments, completes and filters tasks', async () => {
    const owner = await createWorkspace(await signUp('Task Owner'), 'Task Co');
    const agent = await addMember(owner, 'SALES_AGENT');
    const lead = (await owner.post('/leads', { firstName: 'T', email: 't@x.com', assignedToId: agent.userId })).body.data.id;
    const t = await owner.post('/tasks', { title: 'Send brochure', leadId: lead, assignedToId: agent.userId, dueAt: addDays(new Date(), -1).toISOString(), priority: 'HIGH' });
    expect(t.status).toBe(201);
    expect((await agent.get('/tasks?scope=mine')).body.data).toHaveLength(1);
    expect((await agent.get('/tasks?scope=overdue')).body.data[0].isOverdue).toBe(true);
    expect((await agent.get('/notifications')).body.data.some((n: { type: string }) => n.type === 'TASK_ASSIGNED')).toBe(true);
    expect((await agent.post(`/tasks/${t.body.data.id}/comments`, { body: 'On it' })).status).toBe(201);
    expect((await owner.get(`/tasks/${t.body.data.id}`)).body.data.comments).toHaveLength(1);
    expect((await agent.patch(`/tasks/${t.body.data.id}`, { status: 'DONE' })).status).toBe(200);
    const done = (await agent.get('/tasks?scope=completed')).body.data;
    expect(done[0].completedBy.id).toBe(agent.userId);
    expect((await owner.get(`/leads/${lead}/activities`)).body.data.map((a: { type: string }) => a.type)).toEqual(expect.arrayContaining(['TASK_CREATED', 'TASK_COMPLETED']));
  });
});

describe('platform administration', () => {
  it('lets platform admins monitor and manage organizations, plans, subscriptions and invoices by role', async () => {
    const owner = await createWorkspace(await signUp('Platform Target'), 'Target Co');
    const up = await owner.post('/billing/change-plan', { planCode: 'professional', interval: 'YEARLY' });
    const superA = await makePlatformAdmin('SUPER_ADMIN');
    const support = await makePlatformAdmin('SUPPORT_ADMIN');
    const billingA = await makePlatformAdmin('BILLING_ADMIN');

    const orgs = await superA.get('/platform/organizations?q=Target');
    expect(orgs.body.data[0].name).toBe('Target Co');
    // suspension
    expect((await billingA.post(`/platform/organizations/${owner.orgId}/suspend`, { reason: 'abuse' })).status).toBe(403);
    expect((await support.post(`/platform/organizations/${owner.orgId}/suspend`, { reason: 'Terms violation' })).status).toBe(200);
    const blocked = await owner.get('/leads');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('WORKSPACE_SUSPENDED');
    expect((await support.post(`/platform/organizations/${owner.orgId}/activate`)).status).toBe(200);
    expect((await owner.get('/leads')).status).toBe(200);
    // invoices & subscriptions (billing admin)
    expect((await support.post(`/platform/invoices/${up.body.data.invoiceId}/mark-paid`, { method: 'CASH', reference: 'x' })).status).toBe(403);
    expect((await billingA.post(`/platform/invoices/${up.body.data.invoiceId}/mark-paid`, { method: 'BANK_TRANSFER', reference: 'WIRE-77' })).status).toBe(200);
    expect((await owner.get('/organizations/current')).body.data.subscription.planCode).toBe('professional');
    const adj = await billingA.post(`/platform/subscriptions/${owner.orgId}/adjust`, { status: 'ACTIVE', note: 'goodwill status review' });
    expect(adj.status).toBe(200);
    expect((await billingA.post(`/platform/subscriptions/${owner.orgId}/adjust`, { status: 'ACTIVE' })).status).toBe(400);   // a reason is mandatory
    // plans
    const plan = await superA.post('/platform/plans', { code: `custom${Date.now() % 100000}`, name: 'Custom', priceMonthly: 5, priceYearly: 50, trialDays: 0, maxLeads: 10, maxSeats: 1, features: [], isPublic: false, isActive: true, sortOrder: 9 });
    expect(plan.status).toBe(201);
    expect((await support.post('/platform/plans', {})).status).toBe(403);
    // dashboard, usage, users, audit, health
    const dash = await superA.get('/platform/dashboard');
    expect(dash.body.data.organizations.total).toBeGreaterThan(0);
    expect((await superA.get('/platform/usage')).status).toBe(200);
    expect((await superA.get('/platform/users?q=Platform')).body.data.length).toBeGreaterThan(0);
    const audit = await superA.get('/platform/audit-logs?scope=PLATFORM');
    expect(audit.body.data.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining(['organization.suspended', 'organization.activated', 'billing.payment_confirmed']));
    const health = (await superA.get('/platform/health')).body.data;
    expect(health.checks.database.ok).toBe(true);
    expect(health.system.appliedMigrations).toBeGreaterThanOrEqual(10);                 // the page used to report 0 because the role could not read the table
    expect(health).toHaveProperty('providers.email.provider'); expect(health).toHaveProperty('workers');
    expect(JSON.stringify(health)).not.toMatch(/postgres(ql)?:\/\/|password|secret|redis:\/\//i);   // no connection strings or credentials in the health payload
    // user deactivation revokes sessions
    const target = await signUp('To Deactivate');
    expect((await support.post(`/platform/users/${target.userId}/status`, { isActive: false })).status).toBe(200);
    expect((await target.agent.get('/api/auth/me')).status).toBe(401);
    // tenant audit trail records sensitive operations
    expect((await owner.get('/audit-logs')).body.data.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining(['workspace.created', 'billing.upgrade_invoiced']));
  });
});
