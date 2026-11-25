import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, boot, createWorkspace, ownerPrisma, signUp, uniq, type Actor } from './helpers';

beforeAll(async () => { await boot(); });
const newLead = (a: Actor, extra: Record<string, unknown> = {}) => a.post('/leads', { firstName: 'L', email: `l-${uniq()}@x.com`, ...extra });
const countBy = async (orgId: string) => { const rows = await ownerPrisma.lead.groupBy({ by: ['assignedToId'], where: { organizationId: orgId }, _count: true }); return new Map(rows.map((r) => [r.assignedToId, r._count])); };

describe('round-robin assignment is fair, consistent and only uses eligible members', () => {
  it('spreads leads evenly (also under concurrency) and skips non-assignable and deactivated members', async () => {
    const owner = await createWorkspace(await signUp('RR Owner'), `RR ${uniq()}`);
    const manager = await addMember(owner, 'MANAGER'), a1 = await addMember(owner, 'SALES_AGENT'), a2 = await addMember(owner, 'SALES_AGENT'), away = await addMember(owner, 'SALES_AGENT'), gone = await addMember(owner, 'SALES_AGENT');
    expect((await owner.patch('/organizations/current', { autoAssignMode: 'ROUND_ROBIN' })).status).toBe(200);
    const members = (await owner.get('/members')).body.data as Array<{ id: string; userId: string }>;
    const mid = (a: Actor) => members.find((m) => m.userId === a.userId)!.id;
    expect((await owner.patch(`/members/${mid(away)}`, { isAssignable: false })).status).toBe(200);
    expect((await owner.patch(`/members/${mid(gone)}`, { status: 'DEACTIVATED' })).status).toBe(200);
    // 5 assignable members: owner, manager, a1, a2 (+ none else) → 4. 40 leads created 10 at a time in parallel
    for (let round = 0; round < 4; round++) {
      const rs = await Promise.all(Array.from({ length: 10 }, () => newLead(manager, { assignedToId: undefined })));
      expect(rs.every((r) => r.status === 201)).toBe(true);
    }
    const c = await countBy(owner.orgId!);
    for (const who of [owner, manager, a1, a2]) expect(c.get(who.userId), `lead count of ${who.email}`).toBe(10);
    expect(c.get(away.userId) ?? 0).toBe(0); expect(c.get(gone.userId) ?? 0).toBe(0);
    const methods = await ownerPrisma.leadAssignment.groupBy({ by: ['method'], where: { organizationId: owner.orgId! }, _count: true });
    expect(methods).toEqual([expect.objectContaining({ method: 'ROUND_ROBIN', _count: 40 })]);
    // an explicit assignee always wins over automatic assignment; a lead created by an agent belongs to that agent
    expect((await newLead(manager, { assignedToId: a1.userId })).body.data.assignedTo?.id).toBe(a1.userId);
    expect((await newLead(a2)).body.data.assignedTo?.id).toBe(a2.userId);
  });
  it('assignment targets must be active members of THIS workspace', async () => {
    const owner = await createWorkspace(await signUp('AT Owner'), `AT ${uniq()}`);
    const agent = await addMember(owner, 'SALES_AGENT');
    const stranger = await createWorkspace(await signUp('AT Stranger'), `ATB ${uniq()}`);
    const lead = await newLead(owner);
    for (const target of [stranger.userId, '00000000-0000-4000-8000-000000000000']) {
      expect((await owner.post(`/leads/${lead.body.data.id}/assign`, { assignedToId: target })).status, `assign to ${target}`).toBeGreaterThanOrEqual(400);
      expect((await newLead(owner, { assignedToId: target })).status).toBeGreaterThanOrEqual(400);
    }
    expect((await owner.post(`/leads/${lead.body.data.id}/assign`, { assignedToId: agent.userId, note: 'Territory' })).status).toBe(200);
    expect((await owner.post(`/leads/${lead.body.data.id}/assign`, { assignedToId: owner.userId })).status).toBe(200);          // reassignment
    const hist = (await owner.get(`/leads/${lead.body.data.id}/assignments`)).body.data as Array<{ toUser?: { id: string } | null; note?: string | null }>;
    expect(hist.length).toBe(2);
    expect((await ownerPrisma.lead.findUniqueOrThrow({ where: { id: lead.body.data.id } })).assignedToId).toBe(owner.userId);
  });
});

describe('rule-based assignment', () => {
  it('the first matching rule wins, rules rotate inside their pool, ineligible assignees are skipped and no match leaves the lead unassigned', async () => {
    const owner = await createWorkspace(await signUp('Rule Owner'), `Rules ${uniq()}`);     // trial = Professional plan → rule assignment included
    const a1 = await addMember(owner, 'SALES_AGENT'), a2 = await addMember(owner, 'SALES_AGENT'), a3 = await addMember(owner, 'SALES_AGENT');
    const sources = (await owner.get('/lead-sources')).body.data as Array<{ id: string; name: string }>;
    const web = sources.find((s) => s.name === 'Website')!.id, ref = sources.find((s) => s.name === 'Referral')!.id;
    expect((await owner.post('/assignment-rules', { name: 'Referrals to A1', conditions: { sourceIds: [ref] }, assigneeIds: [a1.userId] })).status).toBe(201);
    expect((await owner.post('/assignment-rules', { name: 'Webinar leads', conditions: { campaignContains: 'webinar' }, assigneeIds: [a2.userId, a3.userId] })).status).toBe(201);
    expect((await owner.post('/assignment-rules', { name: 'Everything on the website', conditions: { sourceIds: [web] }, assigneeIds: [a3.userId] })).status).toBe(201);
    expect((await owner.patch('/organizations/current', { autoAssignMode: 'RULES' })).status).toBe(200);
    const who = async (extra: Record<string, unknown>) => ((await newLead(owner, extra)).body.data.assignedTo?.id ?? null) as string | null;
    expect(await who({ sourceId: ref })).toBe(a1.userId);
    expect(await who({ sourceId: ref, campaign: 'Spring Webinar' })).toBe(a1.userId);                 // rule order: the referral rule comes first
    const w1 = await who({ campaign: 'Spring WEBINAR' }), w2 = await who({ campaign: 'webinar x' }), w3 = await who({ campaign: 'webinar y' });
    expect([w1, w2, w3]).toEqual([a2.userId, a3.userId, a2.userId]);                                    // round-robin inside the rule's pool
    expect(await who({ sourceId: web })).toBe(a3.userId);
    expect(await who({ campaign: 'organic' })).toBeNull();                                              // nothing matches → unassigned, visible to managers
    const hist = await ownerPrisma.leadAssignment.groupBy({ by: ['method'], where: { organizationId: owner.orgId! }, _count: true });
    expect(hist).toEqual([expect.objectContaining({ method: 'RULE' })]);
    // a deactivated assignee is skipped (the pool shrinks), and when the whole pool is gone the next rule applies
    const members = (await owner.get('/members')).body.data as Array<{ id: string; userId: string }>;
    expect((await owner.patch(`/members/${members.find((m) => m.userId === a2.userId)!.id}`, { status: 'DEACTIVATED', transferTo: 'UNASSIGN' })).status).toBe(200);
    expect(await who({ campaign: 'webinar z' })).toBe(a3.userId);
    expect((await owner.patch(`/members/${members.find((m) => m.userId === a1.userId)!.id}`, { status: 'DEACTIVATED', transferTo: 'UNASSIGN' })).status).toBe(200);
    expect(await who({ sourceId: ref })).toBeNull();
    // rules can only name active members of this workspace; managers without settings permission cannot edit rules
    const stranger = await createWorkspace(await signUp('Rule Stranger'), `RulesB ${uniq()}`);
    expect((await owner.post('/assignment-rules', { name: 'Bad', conditions: {}, assigneeIds: [stranger.userId] })).status).toBeGreaterThanOrEqual(400);
    expect((await owner.post('/assignment-rules', { name: 'Bad2', conditions: {}, assigneeIds: [a1.userId] })).status).toBeGreaterThanOrEqual(400);   // deactivated
    const agent = await addMember(owner, 'VIEWER');
    expect((await agent.post('/assignment-rules', { name: 'x', conditions: {}, assigneeIds: [a3.userId] })).status).toBe(403);
  });
  it('rule assignment is a Professional feature: enforced on the backend', async () => {
    const owner = await createWorkspace(await signUp('Rule Gate'), `RulesG ${uniq()}`);
    const a = await addMember(owner, 'SALES_AGENT');
    const starter = await ownerPrisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'starter' } });
    await ownerPrisma.subscription.update({ where: { organizationId: owner.orgId! }, data: { planId: starter.id, status: 'ACTIVE', trialEndsAt: null } });
    expect((await owner.post('/assignment-rules', { name: 'x', conditions: {}, assigneeIds: [a.userId] })).status).toBe(402);
    expect((await owner.patch('/organizations/current', { autoAssignMode: 'RULES' })).status).toBe(402);
    expect((await owner.patch('/organizations/current', { autoAssignMode: 'ROUND_ROBIN' })).status).toBe(200);     // round-robin is available on every plan
  });
});

describe('deactivating a member never orphans work', () => {
  it('requires a decision, hands everything over with history, leaves closed work alone, and respects workspace boundaries', async () => {
    const owner = await createWorkspace(await signUp('Off Owner'), `Off ${uniq()}`);
    const leaver = await addMember(owner, 'SALES_AGENT'), heir = await addMember(owner, 'SALES_AGENT'), manager = await addMember(owner, 'MANAGER');
    const stranger = await createWorkspace(await signUp('Off Stranger'), `OffB ${uniq()}`);
    const l1 = (await newLead(manager, { assignedToId: leaver.userId })).body.data.id, l2 = (await newLead(manager, { assignedToId: leaver.userId })).body.data.id, l3 = (await newLead(manager, { assignedToId: leaver.userId })).body.data.id;
    await owner.post(`/leads/${l3}/archive`);                                                     // archived: stays as it was
    const opp = await leaver.post('/opportunities', { leadId: l1, name: 'Big deal', value: 1000 }); expect(opp.status).toBe(201);
    const fu = await leaver.post('/followups', { leadId: l1, dueAt: new Date(Date.now() + 86_400_000).toISOString(), type: 'CALL' }); expect(fu.status).toBe(201);
    const task = await manager.post('/tasks', { title: 'Prepare quote', assignedToId: leaver.userId, leadId: l2 }); expect(task.status).toBe(201);
    const memberId = ((await owner.get('/members')).body.data as Array<{ id: string; userId: string }>).find((m) => m.userId === leaver.userId)!.id;
    // 1. no silent orphaning
    const blocked = await owner.patch(`/members/${memberId}`, { status: 'DEACTIVATED' });
    expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe('HAS_OPEN_WORK');
    expect(blocked.body.error.details.workload).toEqual({ leads: 2, followUps: 1, tasks: 1, opportunities: 1 });
    expect((await ownerPrisma.membership.findUniqueOrThrow({ where: { id: memberId } })).status).toBe('ACTIVE');
    // 2. targets must be active members of this workspace and not the leaver
    expect((await owner.patch(`/members/${memberId}`, { status: 'DEACTIVATED', transferTo: stranger.userId })).status).toBeGreaterThanOrEqual(400);
    expect((await owner.patch(`/members/${memberId}`, { status: 'DEACTIVATED', transferTo: leaver.userId })).status).toBe(400);
    expect((await ownerPrisma.membership.findUniqueOrThrow({ where: { id: memberId } })).status).toBe('ACTIVE');       // a failed hand-over changes nothing
    expect((await agentCannot(leaver, memberId))).toBe(true);
    // 3. hand-over
    const ok = await owner.patch(`/members/${memberId}`, { status: 'DEACTIVATED', transferTo: heir.userId });
    expect(ok.status).toBe(200); expect(ok.body.data.transferred).toEqual({ leads: 2, followUps: 1, tasks: 1, opportunities: 1 });
    expect((await ownerPrisma.lead.findUniqueOrThrow({ where: { id: l1 } })).assignedToId).toBe(heir.userId);
    expect((await ownerPrisma.lead.findUniqueOrThrow({ where: { id: l3 } })).assignedToId).toBe(leaver.userId);      // archived lead untouched
    expect((await ownerPrisma.followUp.findUniqueOrThrow({ where: { id: fu.body.data.id } })).assignedToId).toBe(heir.userId);
    expect((await ownerPrisma.task.findUniqueOrThrow({ where: { id: task.body.data.id } })).assignedToId).toBe(heir.userId);
    expect((await ownerPrisma.opportunity.findUniqueOrThrow({ where: { id: opp.body.data.id } })).ownerId).toBe(heir.userId);
    const hist = await ownerPrisma.leadAssignment.findMany({ where: { leadId: l1 }, orderBy: { createdAt: 'asc' } });
    expect(hist.at(-1)).toMatchObject({ fromUserId: leaver.userId, toUserId: heir.userId, method: 'TRANSFER', assignedById: owner.userId });
    expect((await heir.get(`/leads/${l1}/activities`)).body.data.map((a: { title: string }) => a.title).join('|')).toMatch(/Reassigned from/);
    expect((await heir.get('/notifications')).body.data.map((n: { title: string }) => n.title).join('|')).toMatch(/work was handed to you/);
    // 4. the leaver is out: no access, not part of automatic assignment; reactivation works and does not bring the work back
    expect((await leaver.get('/leads')).status).toBe(403);
    expect((await owner.patch(`/members/${memberId}`, { status: 'ACTIVE' })).status).toBe(200);
    expect((await leaver.get('/leads')).body.meta.total).toBe(0);
    expect((await ownerPrisma.auditLog.findMany({ where: { organizationId: owner.orgId!, action: 'member.updated' } })).some((a) => JSON.stringify(a.metadata).includes('transferred'))).toBe(true);
  });
  it('"release" unassigns leads, tasks and deals; follow-ups go to the administrator so none is left without an owner', async () => {
    const owner = await createWorkspace(await signUp('Rel Owner'), `Rel ${uniq()}`);
    const leaver = await addMember(owner, 'SALES_AGENT');
    const lead = (await newLead(owner, { assignedToId: leaver.userId })).body.data.id;
    const fu = await leaver.post('/followups', { leadId: lead, dueAt: new Date(Date.now() + 86_400_000).toISOString() });
    const memberId = ((await owner.get('/members')).body.data as Array<{ id: string; userId: string }>).find((m) => m.userId === leaver.userId)!.id;
    const r = await owner.patch(`/members/${memberId}`, { status: 'DEACTIVATED', transferTo: 'UNASSIGN' });
    expect(r.status).toBe(200);
    expect((await ownerPrisma.lead.findUniqueOrThrow({ where: { id: lead } })).assignedToId).toBeNull();
    expect((await ownerPrisma.followUp.findUniqueOrThrow({ where: { id: fu.body.data.id } })).assignedToId).toBe(owner.userId);
    expect((await owner.get('/leads?assignedToId=unassigned')).body.meta.total).toBe(1);
  });
  it('a member without any open work can be deactivated directly', async () => {
    const owner = await createWorkspace(await signUp('Free Owner'), `Free ${uniq()}`);
    const idle = await addMember(owner, 'SALES_AGENT');
    const memberId = ((await owner.get('/members')).body.data as Array<{ id: string; userId: string }>).find((m) => m.userId === idle.userId)!.id;
    expect((await owner.patch(`/members/${memberId}`, { status: 'DEACTIVATED' })).status).toBe(200);
  });
});
async function agentCannot(agent: Actor, memberId: string) { return (await agent.patch(`/members/${memberId}`, { status: 'DEACTIVATED', transferTo: 'UNASSIGN' })).status === 403; }
