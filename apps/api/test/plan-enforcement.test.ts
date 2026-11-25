import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, addHours } from 'date-fns';
import { runSchedulerTick } from '../src/modules/automations/scheduler';
import { addMember, boot, confirmInvoicePaid, createWorkspace, makePlatformAdmin, ownerPrisma, signUp, uniq, type Actor } from './helpers';

beforeAll(async () => { await boot(); });
const planId = async (code: string) => (await ownerPrisma.subscriptionPlan.findUniqueOrThrow({ where: { code } })).id;
const setSub = async (orgId: string, code: string, data: Record<string, unknown> = {}) =>
  ownerPrisma.subscription.update({ where: { organizationId: orgId }, data: { planId: await planId(code), status: 'ACTIVE', trialEndsAt: null, ...data } });
const lead = (a: Actor, extra: Record<string, unknown> = {}) => a.post('/leads', { firstName: 'P', email: `p-${uniq()}@x.com`, ...extra });
const seed = (orgId: string, n: number) => ownerPrisma.$executeRawUnsafe(`INSERT INTO leads (id, organization_id, first_name, email, last_activity_at, updated_at) SELECT gen_random_uuid(), '${orgId}', 'S' || g, 's' || g || '-${uniq()}@x.com', now(), now() FROM generate_series(1, ${n}) g`);

describe('trial, free plan and limits never destroy data', () => {
  it('a trial ends on the Free plan: nothing is deleted, existing members keep access, only NEW usage beyond the limits is refused', async () => {
    const owner = await createWorkspace(await signUp('Trial Owner'), `Trial ${uniq()}`);
    const m1 = await addMember(owner, 'MANAGER'), m2 = await addMember(owner, 'SALES_AGENT'), m3 = await addMember(owner, 'SALES_AGENT');
    await seed(owner.orgId!, 80);                                                    // Free allows 50 leads and 2 seats
    const before = await ownerPrisma.lead.count({ where: { organizationId: owner.orgId! } });
    await ownerPrisma.subscription.update({ where: { organizationId: owner.orgId! }, data: { trialEndsAt: addHours(new Date(), -1) } });
    await runSchedulerTick(new Date());
    const b = (await owner.get('/billing')).body.data;
    expect(b.subscription.plan.code).toBe('free'); expect(b.subscription.status).toBe('ACTIVE');
    expect(b.events.map((e: { type: string }) => e.type)).toContain('TRIAL_ENDED');
    expect(await ownerPrisma.lead.count({ where: { organizationId: owner.orgId! } })).toBe(before);       // data intact
    for (const member of [m1, m2, m3]) expect((await member.get('/leads')).status).toBe(200);               // nobody is locked out
    // new usage over the limits is refused with a clear, actionable message
    const over = await lead(owner);
    expect(over.status).toBe(402); expect(over.body.error.code).toBe('LEAD_LIMIT_REACHED'); expect(over.body.error.message).toMatch(/Free plan allows 50 leads/);
    const roles = (await owner.get('/roles')).body.data as Array<{ id: string; systemKey: string }>;
    const inv = await owner.post('/invitations', { email: `x-${uniq()}@x.com`, roleId: roles.find((r) => r.systemKey === 'VIEWER')!.id });
    expect(inv.status).toBe(402); expect(inv.body.error.code).toBe('SEAT_LIMIT_REACHED');
    // existing leads stay fully usable: edit, log activity, archive; after archiving below the cap new leads are accepted again
    const existing = (await owner.get('/leads?pageSize=1')).body.data[0].id;
    expect((await owner.patch(`/leads/${existing}`, { description: 'still editable' })).status).toBe(200);
    expect((await owner.post(`/leads/${existing}/activities`, { type: 'NOTE', title: 'note' })).status).toBe(201);
    const ids = (await owner.get('/leads?pageSize=100')).body.data.slice(0, 40).map((l: { id: string }) => l.id);
    expect((await owner.post('/leads/bulk', { ids, action: 'archive' })).status).toBe(200);
    expect((await lead(owner)).status).toBe(201);
    // backend, not UI: pro features are refused too
    expect((await owner.post('/custom-fields', { label: 'X', type: 'TEXT' })).status).toBe(402);
    expect((await owner.post('/automations', { name: 'x', trigger: 'LEAD_CREATED', conditions: {}, actions: [{ type: 'NOTIFY', recipient: 'OWNER' }] })).status).toBe(402);
    expect((await owner.get('/leads/export?format=csv')).status).toBe(402);
    expect((await owner.agent.post('/api/leads/import?dryRun=true').set('X-Org-Id', owner.orgId!).attach('file', Buffer.from('First Name,Email\nA,a@x.com'), 'a.csv')).status).toBe(402);
    expect((await owner.get('/reports/lead-source?format=csv')).status).toBe(402);
  });
});

describe('grace period, expiry and recovery by a confirmed payment', () => {
  it('grace keeps full access; expiry makes every module read-only (with a precise code); billing stays reachable; confirmed payment restores access; nothing is lost', async () => {
    const owner = await createWorkspace(await signUp('Exp Owner'), `Exp ${uniq()}`);
    const agent = await addMember(owner, 'SALES_AGENT');
    await setSub(owner.orgId!, 'starter', { currentPeriodStart: addDays(new Date(), -30), currentPeriodEnd: addDays(new Date(), 2) });
    const keep = (await lead(owner, { assignedToId: agent.userId })).body.data.id;
    // 1. period ends → PAST_DUE with a renewal invoice; full access during the 7-day grace
    const end = (await ownerPrisma.subscription.findUniqueOrThrow({ where: { organizationId: owner.orgId! } })).currentPeriodEnd;
    await runSchedulerTick(addHours(end, 2));
    let b = (await owner.get('/billing')).body.data;
    expect(b.subscription.status).toBe('PAST_DUE'); expect(b.invoices[0].status).toBe('OPEN');
    expect((await lead(owner)).status).toBe(201);
    // 2. grace over → EXPIRED
    await runSchedulerTick(addDays(end, 9));
    b = (await owner.get('/billing')).body.data;
    expect(b.subscription.status).toBe('EXPIRED');
    const counts = async () => ({ leads: await ownerPrisma.lead.count({ where: { organizationId: owner.orgId! } }), tasks: await ownerPrisma.task.count({ where: { organizationId: owner.orgId! } }) });
    const before = await counts();
    const writes: Array<[string, () => Promise<{ status: number; body: { error?: { code?: string } } }>]> = [
      ['create lead', () => lead(owner)], ['edit lead', () => owner.patch(`/leads/${keep}`, { description: 'x' })],
      ['create task', () => owner.post('/tasks', { title: 'nope' })], ['schedule follow-up', () => owner.post('/followups', { leadId: keep, dueAt: addDays(new Date(), 1).toISOString() })],
      ['log activity', () => owner.post(`/leads/${keep}/activities`, { type: 'CALL', title: 'x' })], ['create opportunity', () => owner.post('/opportunities', { leadId: keep, name: 'd', value: 1 })],
      ['agent edits', () => agent.patch(`/leads/${keep}`, { description: 'x' })], ['create tag', () => owner.post('/tags', { name: 'late' })],
    ];
    for (const [what, run] of writes) { const r = await run(); expect(r.status, what).toBe(402); expect(r.body.error?.code, what).toBe('SUBSCRIPTION_EXPIRED'); }
    expect(await counts()).toEqual(before);
    // reads and billing keep working so the owner can see what is wrong and how to fix it
    for (const url of ['/leads', `/leads/${keep}`, '/tasks', '/followups', '/opportunities/board', '/dashboard', '/billing', '/organizations/current']) expect((await owner.get(url)).status, url).toBe(200);
    expect((await agent.get('/leads')).status).toBe(200);
    // 3. the owner can neither pay nor extend by themselves …
    const openInv = b.invoices.find((i: { status: string }) => i.status === 'FAILED' || i.status === 'OPEN');
    expect((await owner.post(`/billing/invoices/${openInv.id}/record-payment`, { reference: 'self' })).status).toBe(404);
    expect((await owner.post('/billing/reactivate')).body.data.applied).toBe('pending_payment');              // … they can only request a renewal invoice
    expect((await owner.get('/leads')).status).toBe(200);
    // 4. a platform billing admin confirms the money → access is back, data untouched
    const open = (await ownerPrisma.invoice.findMany({ where: { organizationId: owner.orgId!, status: { in: ['OPEN', 'FAILED'] } }, orderBy: { issuedAt: 'desc' } }))[0]!;
    expect((await confirmInvoicePaid(open.id, `WIRE-${uniq()}`)).status).toBe(200);
    expect((await lead(owner)).status).toBe(201);
    expect((await owner.get('/billing')).body.data.subscription.status).toBe('ACTIVE');
    expect((await ownerPrisma.lead.count({ where: { organizationId: owner.orgId! } }))).toBe(before.leads + 1);
  });
});

describe('plan changes, limits and admin overrides', () => {
  it('downgrade is refused while usage exceeds the target plan, scheduled for period end otherwise, and cancelable', async () => {
    const owner = await createWorkspace(await signUp('Down Owner'), `Down ${uniq()}`);
    await setSub(owner.orgId!, 'professional', { currentPeriodEnd: addDays(new Date(), 20) });
    await seed(owner.orgId!, 60);
    const toFree = await owner.post('/billing/change-plan', { planCode: 'free', interval: 'MONTHLY' });
    expect(toFree.status).toBe(409); expect(toFree.body.error.code).toBe('PLAN_USAGE_EXCEEDS'); expect(toFree.body.error.message).toMatch(/60 active leads/);
    const toStarter = await owner.post('/billing/change-plan', { planCode: 'starter', interval: 'MONTHLY' });
    expect(toStarter.body.data.applied).toBe('at_period_end');
    const sub = await ownerPrisma.subscription.findUniqueOrThrow({ where: { organizationId: owner.orgId! }, include: { plan: true } });
    expect(sub.plan.code).toBe('professional');                                       // nothing changes until the period ends
    expect((await owner.post('/billing/reactivate')).status).toBe(200);              // "keep current plan" cancels the scheduled downgrade
    expect((await ownerPrisma.subscription.findUniqueOrThrow({ where: { organizationId: owner.orgId! } })).pendingPlanId).toBeNull();
  });

  it('plan edits and overrides by platform administrators apply immediately; workspace roles decide who sees or changes billing', async () => {
    const owner = await createWorkspace(await signUp('Ovr Owner'), `Ovr ${uniq()}`);
    const manager = await addMember(owner, 'MANAGER'), agent = await addMember(owner, 'SALES_AGENT');
    await setSub(owner.orgId!, 'starter', { currentPeriodEnd: addDays(new Date(), 20) });
    await seed(owner.orgId!, 1000);                                                  // starter allows 1000 leads
    expect((await lead(owner)).status).toBe(402);
    const superA = await makePlatformAdmin('SUPER_ADMIN'), support = await makePlatformAdmin('SUPPORT_ADMIN');
    const plans = (await superA.get('/platform/plans')).body.data as Array<{ id: string; code: string }>;
    expect((await support.agent.patch(`/api/platform/plans/${plans.find((p) => p.code === 'starter')!.id}`).send({ maxLeads: 5000 })).status).toBe(403);
    expect((await superA.agent.patch(`/api/platform/plans/${plans.find((p) => p.code === 'starter')!.id}`).send({ maxLeads: 1001 })).status).toBe(200);
    expect((await lead(owner)).status).toBe(201);                                    // new limit is live at once, no restart, no cache
    expect((await lead(owner)).status).toBe(402);
    await superA.agent.patch(`/api/platform/plans/${plans.find((p) => p.code === 'starter')!.id}`).send({ maxLeads: 1000 });   // restore the shared catalogue
    // billing visibility by role: owner sees and changes; manager/agent have no billing access by default
    expect((await owner.get('/billing')).status).toBe(200);
    expect((await manager.get('/billing')).status).toBe(403); expect((await agent.get('/billing')).status).toBe(403);
    expect((await manager.post('/billing/change-plan', { planCode: 'professional', interval: 'MONTHLY' })).status).toBe(403);
    // a custom role that may VIEW billing cannot change it (plan feature custom_roles is part of the trial/professional)
    await setSub(owner.orgId!, 'professional', { currentPeriodEnd: addDays(new Date(), 20) });
    const role = await owner.post('/roles', { name: 'Finance viewer', permissions: ['billing.view', 'leads.view'] });
    expect(role.status).toBe(201);
    const finance = await addMember(owner, 'VIEWER');
    const members = (await owner.get('/members')).body.data as Array<{ id: string; userId: string }>;
    await owner.patch(`/members/${members.find((m) => m.userId === finance.userId)!.id}`, { roleId: role.body.data.id });
    expect((await finance.get('/billing')).status).toBe(200);
    expect((await finance.post('/billing/change-plan', { planCode: 'starter', interval: 'MONTHLY' })).status).toBe(403);
    expect((await finance.post('/billing/cancel')).status).toBe(403);
  });

  it('a suspended workspace is blocked everywhere except for reading its billing page', async () => {
    const owner = await createWorkspace(await signUp('Sus Owner'), `Sus ${uniq()}`);
    const support = await makePlatformAdmin('SUPPORT_ADMIN');
    expect((await support.agent.post(`/api/platform/organizations/${owner.orgId}/suspend`).send({ reason: 'Terms violation test' })).status).toBe(200);
    expect((await owner.get('/leads')).body.error.code).toBe('WORKSPACE_SUSPENDED');
    expect((await lead(owner)).status).toBe(403);
    expect((await owner.get('/billing')).status).toBe(200);
    expect((await owner.post('/billing/change-plan', { planCode: 'starter', interval: 'MONTHLY' })).status).toBe(403);
    expect((await support.agent.post(`/api/platform/organizations/${owner.orgId}/activate`)).status).toBe(200);
    expect((await owner.get('/leads')).status).toBe(200);
  });
});
