import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { executeAutomation } from '../src/modules/automations/engine';
import { addMember, boot, createWorkspace, ownerPrisma, signUp, uniq, type Actor } from './helpers';

beforeAll(async () => { await boot(); });
const lead = (a: Actor, extra: Record<string, unknown> = {}) => a.post('/leads', { firstName: 'Auto', email: `au-${uniq()}@x.com`, ...extra });
const rule = (a: Actor, body: Record<string, unknown>) => a.post('/automations', { conditions: {}, ...body });
const execs = (orgId: string, ruleId?: string) => ownerPrisma.automationExecution.findMany({ where: { organizationId: orgId, ...(ruleId ? { ruleId } : {}) }, orderBy: { createdAt: 'asc' } });

describe('automation actions: assign lead and schedule follow-up', () => {
  it('ASSIGN_LEAD round-robin gives new unassigned leads an owner, records history, notifies, and leaves owned leads alone', async () => {
    const owner = await createWorkspace(await signUp('AA Owner'), `AA ${uniq()}`);
    const a1 = await addMember(owner, 'SALES_AGENT'), a2 = await addMember(owner, 'SALES_AGENT');
    const r = await rule(owner, { name: 'Distribute new leads', trigger: 'LEAD_CREATED', actions: [{ type: 'ASSIGN_LEAD', mode: 'ROUND_ROBIN', onlyIfUnassigned: true }] });
    expect(r.status).toBe(201);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await lead(owner)).body.data.id);
    const rows = await ownerPrisma.lead.findMany({ where: { id: { in: ids } } });
    const per = new Map<string | null, number>(); for (const l of rows) per.set(l.assignedToId, (per.get(l.assignedToId) ?? 0) + 1);
    expect([...per.values()].every((n) => n === 2)).toBe(true); expect(per.size).toBe(3);        // owner, a1, a2 share evenly
    const hist = await ownerPrisma.leadAssignment.findFirstOrThrow({ where: { leadId: rows.find((l) => l.assignedToId === a1.userId)!.id } });
    expect(hist).toMatchObject({ method: 'AUTOMATION', assignedById: null }); expect(hist.note).toContain('Distribute new leads');
    expect((await a1.get('/notifications')).body.data.map((n: { title: string }) => n.title).join('|')).toMatch(/Lead assigned to you/);
    // an owned lead is not touched
    const owned = await lead(owner, { assignedToId: a2.userId });
    expect(owned.body.data.assignedTo.id).toBe(a2.userId);
    const e = (await execs(owner.orgId!, r.body.data.id)).at(-1)!;
    expect(e.status).toBe('SUCCESS'); expect(JSON.stringify(e.result)).toContain('already has an owner');
    expect((await a2.get(`/leads/${owned.body.data.id}/activities`)).body.data.filter((a: { title: string }) => /by automation/.test(a.title))).toHaveLength(0);
  });

  it('CREATE_FOLLOWUP schedules a real follow-up for the lead owner (calendar, timeline and notification included)', async () => {
    const owner = await createWorkspace(await signUp('FU Owner'), `FU ${uniq()}`);
    const agent = await addMember(owner, 'SALES_AGENT');
    const r = await rule(owner, { name: 'Call new leads tomorrow', trigger: 'LEAD_ASSIGNED', actions: [{ type: 'CREATE_FOLLOWUP', followUpType: 'WHATSAPP', assignee: 'OWNER', dueInHours: 24, notes: 'Introduce the product' }] });
    expect(r.status).toBe(201);
    const l = await lead(owner, { assignedToId: agent.userId });
    const fu = await ownerPrisma.followUp.findFirstOrThrow({ where: { leadId: l.body.data.id } });
    expect(fu).toMatchObject({ type: 'WHATSAPP', status: 'PENDING', assignedToId: agent.userId, notes: 'Introduce the product' });
    expect(Math.abs(fu.dueAt.getTime() - (Date.now() + 86_400_000))).toBeLessThan(5 * 60_000);
    expect((await agent.get('/followups?view=upcoming')).body.data.map((f: { id: string }) => f.id)).toContain(fu.id);
    expect((await agent.get(`/leads/${l.body.data.id}/activities`)).body.data.map((a: { title: string }) => a.title).join('|')).toMatch(/Follow-up scheduled by automation/);
    expect((await agent.get('/notifications')).body.data.map((n: { title: string }) => n.title).join('|')).toMatch(/New follow-up/);
    // the follow-up is a normal one: the agent can complete it
    const done = await agent.post(`/followups/${fu.id}/complete`, { outcome: 'SUCCESSFULLY_CONTACTED' });
    expect(done.status).toBe(200);
  });
});

describe('safety: no loops, no floods, no cross-workspace effects', () => {
  it('actions performed by an automation never start another automation (assignment ↔ assignment loop is impossible)', async () => {
    const owner = await createWorkspace(await signUp('Loop Owner'), `Loop ${uniq()}`);
    await addMember(owner, 'SALES_AGENT'); await addMember(owner, 'SALES_AGENT');
    // the classic loop: "when a lead is assigned → reassign it round-robin" would ping-pong forever without the guard
    const r1 = await rule(owner, { name: 'Reshuffle', trigger: 'LEAD_ASSIGNED', actions: [{ type: 'ASSIGN_LEAD', mode: 'ROUND_ROBIN', onlyIfUnassigned: false }] });
    const r2 = await rule(owner, { name: 'Task on assignment', trigger: 'LEAD_ASSIGNED', actions: [{ type: 'CREATE_TASK', title: 'Welcome call', assignee: 'OWNER' }] });
    const l = await lead(owner, { assignedToId: owner.userId });
    expect((await execs(owner.orgId!, r1.body.data.id))).toHaveLength(1);         // fired once for the human's assignment, not again for its own reassignment
    expect((await execs(owner.orgId!, r2.body.data.id))).toHaveLength(1);
    expect(await ownerPrisma.task.count({ where: { organizationId: owner.orgId!, leadId: l.body.data.id } })).toBe(1);
    expect(await ownerPrisma.leadAssignment.count({ where: { leadId: l.body.data.id } })).toBeLessThanOrEqual(2);   // the initial assignment + at most one automated reassignment, then it stops
    expect((await execs(owner.orgId!)).every((e) => e.status === 'SUCCESS')).toBe(true);
  });

  it('a workspace cannot exceed its hourly automation budget and is told so', async () => {
    const owner = await createWorkspace(await signUp('Cap Owner'), `Cap ${uniq()}`);
    const r = await rule(owner, { name: 'Notify', trigger: 'LEAD_CREATED', actions: [{ type: 'NOTIFY', recipient: 'MANAGERS' }] });
    const before = config.automationMaxPerHour;
    (config as { automationMaxPerHour: number }).automationMaxPerHour = 3;
    try {
      for (let i = 0; i < 6; i++) expect((await lead(owner)).status).toBe(201);             // creating leads is never blocked by the cap
      expect((await execs(owner.orgId!)).length).toBe(3);                                  // the budget covers every rule of the workspace
      expect(r.status).toBe(201);
      const list = (await owner.get('/automations')).body.data;
      expect(list).toMatchObject({ throttled: true, hourlyCap: 3 });
    } finally { (config as { automationMaxPerHour: number }).automationMaxPerHour = before; }
  });

  it('rules are limited per workspace and may only reference members of the same workspace', async () => {
    const owner = await createWorkspace(await signUp('Lim Owner'), `Lim ${uniq()}`);
    const other = await createWorkspace(await signUp('Lim Other'), `LimB ${uniq()}`);
    expect((await rule(owner, { name: 'x1', trigger: 'LEAD_CREATED', actions: [{ type: 'ASSIGN_LEAD', mode: 'USER', userId: other.userId }] })).status).toBeGreaterThanOrEqual(400);
    expect((await rule(owner, { name: 'x2', trigger: 'LEAD_CREATED', actions: [{ type: 'CREATE_FOLLOWUP', assignee: 'USER', userId: other.userId, dueInHours: 2 }] })).status).toBeGreaterThanOrEqual(400);
    expect((await rule(owner, { name: 'x3', trigger: 'LEAD_CREATED', actions: [{ type: 'ASSIGN_LEAD', mode: 'USER' }] })).status).toBe(400);
    const before = config.automationMaxRules;
    (config as { automationMaxRules: number }).automationMaxRules = (await ownerPrisma.automationRule.count({ where: { organizationId: owner.orgId! } })) + 1;
    try {
      expect((await rule(owner, { name: 'last allowed', trigger: 'LEAD_CREATED', actions: [{ type: 'NOTIFY', recipient: 'OWNER' }] })).status).toBe(201);
      expect((await rule(owner, { name: 'one too many', trigger: 'LEAD_CREATED', actions: [{ type: 'NOTIFY', recipient: 'OWNER' }] })).body.error.code).toBe('TOO_MANY_RULES');
    } finally { (config as { automationMaxRules: number }).automationMaxRules = before; }
  });

  it('one workspace\'s automations and executions are invisible to and unusable by another', async () => {
    const a = await createWorkspace(await signUp('Iso A'), `IsoA ${uniq()}`), b = await createWorkspace(await signUp('Iso B'), `IsoB ${uniq()}`);
    const ra = await rule(a, { name: 'A only', trigger: 'LEAD_CREATED', actions: [{ type: 'CREATE_TASK', title: 'A task', assignee: 'OWNER' }] });
    await lead(b);                                                                          // a lead in B never fires A's rule
    expect(await execs(a.orgId!, ra.body.data.id)).toHaveLength(0);
    expect(await ownerPrisma.task.count({ where: { organizationId: b.orgId!, title: 'A task' } })).toBe(0);
    const la = await lead(a);
    const exA = (await execs(a.orgId!, ra.body.data.id))[0]!;
    expect((await b.get('/automations')).body.data.rules.filter((r: { name: string }) => r.name === 'A only')).toHaveLength(0);
    expect((await b.get('/automations/executions')).body.data.filter((e: { rule: { id: string } }) => e.rule.id === ra.body.data.id)).toHaveLength(0);
    expect((await b.post(`/automations/executions/${exA.id}/retry`)).status).toBe(404);
    expect((await b.patch(`/automations/${ra.body.data.id}`, { name: 'hijacked' })).status).toBe(404);
    expect((await b.post(`/automations/${ra.body.data.id}/toggle`)).status).toBe(404);
    // even a forged job for A's execution under B's workspace id does nothing
    const tasksBefore = await ownerPrisma.task.count();
    await ownerPrisma.automationExecution.update({ where: { id: exA.id }, data: { status: 'PENDING' } });
    await executeAutomation(b.orgId!, exA.id);
    expect(await ownerPrisma.task.count()).toBe(tasksBefore);
    expect((await ownerPrisma.automationExecution.findUniqueOrThrow({ where: { id: exA.id } })).status).toBe('PENDING');
    expect(la.status).toBe(201);
  });
});

describe('failure visibility, retry, editing and disabling', () => {
  it('a failing execution is visible with its error, can be retried after the rule is fixed, and attempts are counted', async () => {
    const owner = await createWorkspace(await signUp('Fail Owner'), `Fail ${uniq()}`);
    const agent = await addMember(owner, 'SALES_AGENT');
    const r = await rule(owner, { name: 'Give to Sam', trigger: 'LEAD_CREATED', actions: [{ type: 'CREATE_TASK', title: 'Should roll back', assignee: 'OWNER' }, { type: 'ASSIGN_LEAD', mode: 'USER', userId: agent.userId }] });
    const members = (await owner.get('/members')).body.data as Array<{ id: string; userId: string }>;
    await ownerPrisma.membership.update({ where: { id: members.find((m) => m.userId === agent.userId)!.id }, data: { status: 'DEACTIVATED' } });   // the target leaves
    const l = await lead(owner);
    expect(l.status).toBe(201);                                                                  // creating the lead itself is unaffected
    const failed = (await owner.get('/automations/executions?status=FAILED')).body.data as Array<{ id: string; error: string; attempts: number; rule: { name: string } }>;
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toMatch(/no longer active/); expect(failed[0]!.rule.name).toBe('Give to Sam'); expect(failed[0]!.attempts).toBe(1);
    expect(await ownerPrisma.task.count({ where: { organizationId: owner.orgId!, title: 'Should roll back' } })).toBe(0);   // all-or-nothing: the first action was rolled back
    expect((await owner.get('/automations')).body.data.rules.find((x: { id: string }) => x.id === r.body.data.id).stats).toMatchObject({ FAILED: 1 });
    // fix the rule, retry → success exactly once
    expect((await owner.patch(`/automations/${r.body.data.id}`, { actions: [{ type: 'CREATE_TASK', title: 'Should roll back', assignee: 'OWNER' }, { type: 'ASSIGN_LEAD', mode: 'ROUND_ROBIN' }] })).status).toBe(200);
    expect((await owner.post(`/automations/executions/${failed[0]!.id}/retry`)).status).toBe(200);
    const ex = await ownerPrisma.automationExecution.findUniqueOrThrow({ where: { id: failed[0]!.id } });
    expect(ex.status).toBe('SUCCESS'); expect(ex.attempts).toBe(2); expect(ex.error).toBeNull();
    expect(await ownerPrisma.task.count({ where: { organizationId: owner.orgId!, title: 'Should roll back' } })).toBe(1);
    expect((await owner.post(`/automations/executions/${failed[0]!.id}/retry`)).status).toBe(409);       // a successful run cannot be repeated
  });

  it('disabling stops new runs and skips pending ones; editing changes the behaviour; built-in rules can be disabled but not deleted', async () => {
    const owner = await createWorkspace(await signUp('Dis Owner'), `Dis ${uniq()}`);
    const r = await rule(owner, { name: 'Task per lead', trigger: 'LEAD_CREATED', actions: [{ type: 'CREATE_TASK', title: 'Original', assignee: 'OWNER' }] });
    await lead(owner);
    expect(await ownerPrisma.task.count({ where: { organizationId: owner.orgId!, title: 'Original' } })).toBe(1);
    expect((await owner.post(`/automations/${r.body.data.id}/toggle`)).body.data.isEnabled).toBe(false);
    const n = (await execs(owner.orgId!, r.body.data.id)).length;
    await lead(owner);
    expect((await execs(owner.orgId!, r.body.data.id)).length).toBe(n);                   // disabled: no new executions
    // a pending execution of a rule that was disabled meanwhile is skipped, not run
    const ex = (await execs(owner.orgId!, r.body.data.id))[0]!;
    await ownerPrisma.automationExecution.update({ where: { id: ex.id }, data: { status: 'PENDING', finishedAt: null } });
    await executeAutomation(owner.orgId!, ex.id);
    expect((await ownerPrisma.automationExecution.findUniqueOrThrow({ where: { id: ex.id } })).status).toBe('SKIPPED');
    expect(await ownerPrisma.task.count({ where: { organizationId: owner.orgId!, title: 'Original' } })).toBe(1);
    await owner.post(`/automations/${r.body.data.id}/toggle`);
    expect((await owner.patch(`/automations/${r.body.data.id}`, { actions: [{ type: 'CREATE_TASK', title: 'Edited', assignee: 'OWNER' }] })).status).toBe(200);
    await lead(owner);
    expect(await ownerPrisma.task.count({ where: { organizationId: owner.orgId!, title: 'Edited' } })).toBe(1);
    const sys = (await owner.get('/automations')).body.data.rules.find((x: { isSystem: boolean }) => x.isSystem);
    if (sys) { expect((await owner.del(`/automations/${sys.id}`)).status).toBe(409); expect((await owner.post(`/automations/${sys.id}/toggle`)).status).toBe(200); }
    expect((await owner.del(`/automations/${r.body.data.id}`)).status).toBe(200);
  });

  it('the plan is enforced in the backend: no automations on Free, and existing rules stop executing', async () => {
    const owner = await createWorkspace(await signUp('Plan Owner'), `PlanA ${uniq()}`);
    const r = await rule(owner, { name: 'Until downgrade', trigger: 'LEAD_CREATED', actions: [{ type: 'CREATE_TASK', title: 'Plan task', assignee: 'OWNER' }] });
    const free = await ownerPrisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'free' } });
    await ownerPrisma.subscription.update({ where: { organizationId: owner.orgId! }, data: { planId: free.id, status: 'ACTIVE', trialEndsAt: null } });
    expect((await rule(owner, { name: 'New on free', trigger: 'LEAD_CREATED', actions: [{ type: 'NOTIFY', recipient: 'OWNER' }] })).status).toBe(402);
    await lead(owner);
    const e = (await execs(owner.orgId!, r.body.data.id)).at(-1)!;
    expect(e.status).toBe('SKIPPED'); expect(JSON.stringify(e.result)).toMatch(/not included in the current plan/);
    expect(await ownerPrisma.task.count({ where: { organizationId: owner.orgId!, title: 'Plan task' } })).toBe(0);
  });
});
