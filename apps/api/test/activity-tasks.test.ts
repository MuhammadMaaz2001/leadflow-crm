import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, addHours, addMinutes } from 'date-fns';
import { runSchedulerTick } from '../src/modules/automations/scheduler';
import { addMember, boot, createWorkspace, ownerPrisma, signUp, uniq, type Actor } from './helpers';

beforeAll(async () => { await boot(); });
const lead = (a: Actor, extra: Record<string, unknown> = {}) => a.post('/leads', { firstName: 'T', email: `t-${uniq()}@x.com`, ...extra });
const iso = (d: Date) => d.toISOString();
const titles = async (a: Actor) => ((await a.get('/notifications?pageSize=100')).body.data as Array<{ title: string }>).map((n) => n.title);

describe('manual activity logging records what happened without pretending to send anything', () => {
  it('every manual type lands on the timeline, marks first contact, respects permissions and never leaks across workspaces', async () => {
    const owner = await createWorkspace(await signUp('Act Owner'), `Act ${uniq()}`);
    const agent = await addMember(owner, 'SALES_AGENT'), other = await addMember(owner, 'SALES_AGENT'), viewer = await addMember(owner, 'VIEWER');
    const stranger = await createWorkspace(await signUp('Act Stranger'), `ActB ${uniq()}`);
    const l = (await lead(owner, { assignedToId: agent.userId })).body.data.id;
    expect((await ownerPrisma.lead.findUniqueOrThrow({ where: { id: l } })).firstContactedAt).toBeNull();
    for (const [type, extra] of [['CALL', { direction: 'OUTBOUND', durationMinutes: 12 }], ['EMAIL', { direction: 'OUTBOUND', title: 'Sent proposal' }], ['WHATSAPP', { direction: 'INBOUND' }], ['MEETING', {}], ['NOTE', { body: 'Prefers mornings' }]] as const) {
      const r = await agent.post(`/leads/${l}/activities`, { type, body: `manual ${type}`, ...extra });
      expect(r.status, type).toBe(201);
    }
    const tl = (await agent.get(`/leads/${l}/activities?pageSize=50`)).body.data as Array<{ type: string; body: string | null; actor: { id: string } | null; metadata: Record<string, unknown> }>;
    for (const t of ['CALL', 'EMAIL', 'WHATSAPP', 'MEETING', 'NOTE']) expect(tl.some((a) => a.type === t && a.actor?.id === agent.userId), t).toBe(true);
    expect(tl.find((a) => a.type === 'CALL')!.metadata).toMatchObject({ direction: 'OUTBOUND', durationMinutes: 12 });
    const row = await ownerPrisma.lead.findUniqueOrThrow({ where: { id: l } });
    expect(row.firstContactedAt).not.toBeNull(); expect(row.status).toBe('CONTACTED');                          // a logged contact attempt advances the lead
    // a timeline entry written by hand never queues an e-mail or message anywhere
    expect(await ownerPrisma.outboundEmail.count({ where: { subject: { contains: 'manual' } } })).toBe(0);
    // validation: types, future dates, lengths
    expect((await agent.post(`/leads/${l}/activities`, { type: 'SMS', body: 'x' })).status).toBe(400);
    expect((await agent.post(`/leads/${l}/activities`, { type: 'CALL', body: 'x'.repeat(5001) })).status).toBe(400);
    expect((await agent.post(`/leads/${l}/activities`, { type: 'CALL', durationMinutes: -3 })).status).toBe(400);
    // permissions: not the owner of the lead, viewers and strangers cannot log
    expect((await other.post(`/leads/${l}/activities`, { type: 'NOTE', body: 'not mine' })).status).toBe(404);
    expect((await viewer.post(`/leads/${l}/activities`, { type: 'NOTE', body: 'read only' })).status).toBeGreaterThanOrEqual(403);
    expect((await stranger.post(`/leads/${l}/activities`, { type: 'NOTE', body: 'other workspace' })).status).toBe(404);
    expect((await stranger.get(`/leads/${l}/activities`)).status).toBe(404);
    expect((await owner.get(`/activities`)).body.data.length).toBeGreaterThan(0);
    expect((await stranger.get('/activities')).body.data.filter((a: { lead?: { id: string } }) => a.lead?.id === l)).toHaveLength(0);
  });
});

describe('follow-ups: schedule, reschedule, complete, calendar and reminders', () => {
  it('rejects past dates, tracks reschedules, completes with next step, and shows in the calendar for the right window and people only', async () => {
    const owner = await createWorkspace(await signUp('FU Owner'), `FUp ${uniq()}`);
    const agent = await addMember(owner, 'SALES_AGENT'), other = await addMember(owner, 'SALES_AGENT');
    const l = (await lead(owner, { assignedToId: agent.userId })).body.data.id;
    expect((await agent.post('/followups', { leadId: l, dueAt: iso(addDays(new Date(), -2)) })).status).toBe(400);
    const due = addDays(new Date(), 3);
    const fu = (await agent.post('/followups', { leadId: l, dueAt: iso(due), type: 'WHATSAPP', priority: 'HIGH' })).body.data.id;
    expect((await other.get(`/followups/${fu}`)).status).toBe(404);
    expect((await other.post(`/followups/${fu}/complete`, { outcome: 'NO_ANSWER' })).status).toBe(404);
    const to = addDays(new Date(), 5);
    expect((await agent.post(`/followups/${fu}/reschedule`, { dueAt: iso(to), reason: 'Client travelling' })).status).toBe(200);
    expect((await agent.post(`/followups/${fu}/reschedule`, { dueAt: iso(addDays(new Date(), -1)) })).status).toBe(400);
    const detail = (await agent.get(`/followups/${fu}`)).body.data;
    expect(detail.rescheduleCount).toBe(1);
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['CREATED', 'RESCHEDULED']));
    // calendar: inside the window yes (as the new date), outside no; other people's only with permission
    const win = (a: Date, b: Date) => `/calendar?from=${iso(a)}&to=${iso(b)}`;
    expect((await agent.get(win(addDays(new Date(), 4), addDays(new Date(), 6)))).body.data.map((e: { id: string }) => e.id)).toContain(fu);
    expect((await agent.get(win(addDays(new Date(), 2), addDays(new Date(), 4)))).body.data.map((e: { id: string }) => e.id)).not.toContain(fu);
    expect((await other.get(win(addDays(new Date(), 4), addDays(new Date(), 6)))).body.data.map((e: { id: string }) => e.id)).not.toContain(fu);
    expect((await owner.get(win(addDays(new Date(), 4), addDays(new Date(), 6)))).body.data.map((e: { id: string }) => e.id)).toContain(fu);
    expect((await agent.get(win(new Date(), addDays(new Date(), 400)))).status).toBe(400);                         // window limited to 100 days
    // completion: needs an outcome; next step becomes a new follow-up; cannot complete twice
    expect((await agent.post(`/followups/${fu}/complete`, {})).status).toBe(400);
    const done = await agent.post(`/followups/${fu}/complete`, { outcome: 'CALLBACK_REQUESTED', outcomeNotes: 'Call Monday', next: { dueAt: iso(addDays(new Date(), 8)), type: 'CALL' } });
    expect(done.status).toBe(200);
    expect((await agent.post(`/followups/${fu}/complete`, { outcome: 'NO_ANSWER' })).status).toBeGreaterThanOrEqual(400);   // already completed
    expect((await agent.get('/followups?view=upcoming')).body.data.some((f: { type: string }) => f.type === 'CALL')).toBe(true);
    const sum = (await agent.get('/followups/summary')).body.data;
    expect(sum.completedToday).toBe(1);
    expect(sum.upcoming).toBeGreaterThanOrEqual(0);
  });

  it('the scheduler sends in-app reminders once, then an overdue notice once; nothing is sent for archived leads, canceled or completed items', async () => {
    const owner = await createWorkspace(await signUp('Rem Owner'), `Rem ${uniq()}`);
    const agent = await addMember(owner, 'SALES_AGENT');
    const mk = async (extra: Record<string, unknown> = {}) => (await lead(owner, { assignedToId: agent.userId, ...extra })).body.data.id as string;
    const l1 = await mk(), l2 = await mk(), l3 = await mk(), l4 = await mk();
    const soon = addMinutes(new Date(), 10);
    const f1 = (await agent.post('/followups', { leadId: l1, dueAt: iso(soon) })).body.data.id;
    const f2 = (await agent.post('/followups', { leadId: l2, dueAt: iso(soon) })).body.data.id;      // will be canceled
    const f3 = (await agent.post('/followups', { leadId: l3, dueAt: iso(soon) })).body.data.id;      // lead archived
    await agent.post(`/followups/${f2}/cancel`, { reason: 'no longer needed' });
    await owner.post(`/leads/${l3}/archive`);
    await runSchedulerTick(new Date()); await runSchedulerTick(new Date());                            // twice: no duplicates
    const t1 = await titles(agent);
    expect(t1.filter((t) => t.startsWith('Follow-up due soon'))).toHaveLength(1);
    expect((await ownerPrisma.followUp.findUniqueOrThrow({ where: { id: f1 } })).reminderSentAt).not.toBeNull();
    expect((await ownerPrisma.followUp.findUniqueOrThrow({ where: { id: f2 } })).reminderSentAt).toBeNull();
    expect((await ownerPrisma.followUp.findUniqueOrThrow({ where: { id: f3 } })).reminderSentAt).toBeNull();
    await runSchedulerTick(addHours(new Date(), 1)); await runSchedulerTick(addHours(new Date(), 1));
    const t2 = await titles(agent);
    expect(t2.filter((t) => t.startsWith('Follow-up overdue'))).toHaveLength(1);                       // f1 only
    // completed items stop generating notices
    const l5 = await mk(); const f5 = (await agent.post('/followups', { leadId: l5, dueAt: iso(addMinutes(new Date(), 5)) })).body.data.id;
    await agent.post(`/followups/${f5}/complete`, { outcome: 'SUCCESSFULLY_CONTACTED' });
    await runSchedulerTick(addHours(new Date(), 3));
    expect((await titles(agent)).filter((t) => t.startsWith('Follow-up overdue'))).toHaveLength(1);
    void l4;
  });
});

describe('tasks: priority, due dates, assignment, overdue handling and reminders', () => {
  it('validates input, restricts assignment to active members, tracks completion and shows overdue tasks', async () => {
    const owner = await createWorkspace(await signUp('Task Owner'), `Tasks ${uniq()}`);
    const agent = await addMember(owner, 'SALES_AGENT'), other = await addMember(owner, 'SALES_AGENT'), viewer = await addMember(owner, 'VIEWER');
    const stranger = await createWorkspace(await signUp('Task Stranger'), `TasksB ${uniq()}`);
    expect((await owner.post('/tasks', { title: '' })).status).toBe(400);
    expect((await owner.post('/tasks', { title: 'x', priority: 'URGENT' })).status).toBe(400);
    expect((await owner.post('/tasks', { title: 'x', assignedToId: stranger.userId })).status).toBeGreaterThanOrEqual(400);
    expect((await viewer.post('/tasks', { title: 'viewer task' })).status).toBe(403);
    const t = await owner.post('/tasks', { title: 'Send quote', priority: 'HIGH', dueAt: iso(addHours(new Date(), -3)), assignedToId: agent.userId });
    expect(t.status).toBe(201);
    expect((await agent.get('/tasks?scope=overdue')).body.data.map((x: { id: string }) => x.id)).toContain(t.body.data.id);
    expect((await other.get('/tasks?scope=team')).body.data.map((x: { id: string }) => x.id)).not.toContain(t.body.data.id);     // not visible to another agent
    expect((await owner.get('/tasks?scope=team')).body.data.map((x: { id: string }) => x.id)).toContain(t.body.data.id);
    expect((await agent.get('/tasks?priority=HIGH&scope=mine')).body.data).toHaveLength(1);
    expect((await agent.get('/tasks?priority=LOW&scope=mine')).body.data).toHaveLength(0);
    expect((await stranger.get(`/tasks/${t.body.data.id}`)).status).toBe(404);
    expect((await other.patch(`/tasks/${t.body.data.id}`, { status: 'DONE' })).status).toBe(404);
    // the task appears in the calendar by its due date; completing removes it from "overdue" and records who/when
    const from = iso(addHours(new Date(), -6)), to = iso(addHours(new Date(), 6));
    expect((await agent.get(`/calendar?from=${from}&to=${to}&kinds=task`)).body.data.find((e: { id: string }) => e.id === t.body.data.id)).toMatchObject({ kind: 'task', overdue: true, priority: 'HIGH' });
    expect((await agent.patch(`/tasks/${t.body.data.id}`, { status: 'DONE' })).status).toBe(200);
    const row = await ownerPrisma.task.findUniqueOrThrow({ where: { id: t.body.data.id } });
    expect(row.status).toBe('DONE'); expect(row.completedById).toBe(agent.userId); expect(row.completedAt).not.toBeNull();
    expect((await agent.get('/tasks?scope=overdue')).body.data.map((x: { id: string }) => x.id)).not.toContain(t.body.data.id);
    expect((await agent.patch(`/tasks/${t.body.data.id}`, { status: 'TODO' })).status).toBe(200);                                  // reopen clears the completion
    expect((await ownerPrisma.task.findUniqueOrThrow({ where: { id: t.body.data.id } })).completedById).toBeNull();
    // reassignment notifies the new owner and re-arms the reminder
    expect((await owner.patch(`/tasks/${t.body.data.id}`, { assignedToId: other.userId })).status).toBe(200);
    expect((await titles(other)).join('|')).toMatch(/Task assigned to you: Send quote/);
  });

  it('reminders: an approaching deadline and an overdue task each notify the assignee exactly once', async () => {
    const owner = await createWorkspace(await signUp('TR Owner'), `TaskR ${uniq()}`);
    const agent = await addMember(owner, 'SALES_AGENT');
    await owner.post('/tasks', { title: 'Soon task', dueAt: iso(addMinutes(new Date(), 60)), assignedToId: agent.userId });
    await owner.post('/tasks', { title: 'Done task', dueAt: iso(addMinutes(new Date(), 30)), assignedToId: agent.userId, status: 'DONE' }).catch(() => undefined);
    await runSchedulerTick(new Date()); await runSchedulerTick(new Date());
    expect((await titles(agent)).filter((t) => /deadline approaching: Soon task/.test(t))).toHaveLength(1);
    expect((await titles(agent)).filter((t) => /overdue: Soon task/.test(t))).toHaveLength(0);
    await runSchedulerTick(addHours(new Date(), 5)); await runSchedulerTick(addHours(new Date(), 6));
    expect((await titles(agent)).filter((t) => /deadline approaching: Soon task/.test(t))).toHaveLength(1);   // still just one approaching notice…
    expect((await titles(agent)).filter((t) => /Task overdue: Soon task/.test(t))).toHaveLength(1);           // …and ONE overdue notice, even though a reminder was sent before
    // changing the due date re-arms both notices
    const t = (await agent.get('/tasks?scope=mine&q=Soon')).body.data[0].id;
    await owner.patch(`/tasks/${t}`, { dueAt: iso(addHours(new Date(), 8)) });
    const row = await ownerPrisma.task.findUniqueOrThrow({ where: { id: t } });
    expect(row.reminderSentAt).toBeNull(); expect(row.overdueNotifiedAt).toBeNull();
  });
});

describe('in-app notifications', () => {
  it('are delivered per user, can be read/unread/cleared, honour preferences and never cross users or workspaces', async () => {
    const owner = await createWorkspace(await signUp('Not Owner'), `Notif ${uniq()}`);
    const a = await addMember(owner, 'SALES_AGENT'), b = await addMember(owner, 'SALES_AGENT');
    const stranger = await createWorkspace(await signUp('Not Stranger'), `NotifB ${uniq()}`);
    await lead(owner, { assignedToId: a.userId, firstName: 'Notify' });
    const mine = (await a.get('/notifications')).body.data as Array<{ id: string; title: string; readAt: string | null }>;
    expect(mine.some((n) => /Notify/.test(n.title))).toBe(true);
    expect((await b.get('/notifications')).body.data.some((n: { title: string }) => /Notify/.test(n.title))).toBe(false);
    expect((await stranger.get('/notifications')).body.data).toHaveLength(0);
    const unread = (await a.get('/notifications/unread-count')).body.data.unread;
    expect(unread).toBeGreaterThan(0);
    expect((await b.post(`/notifications/${mine[0]!.id}/read`)).status).toBeGreaterThanOrEqual(400);   // someone else's notification
    expect((await stranger.post(`/notifications/${mine[0]!.id}/read`)).status).toBeGreaterThanOrEqual(400);
    expect((await a.post(`/notifications/${mine[0]!.id}/read`)).status).toBe(200);
    expect((await a.get('/notifications/unread-count')).body.data.unread).toBe(unread - 1);
    expect((await a.post(`/notifications/${mine[0]!.id}/unread`)).status).toBe(200);
    expect((await a.post('/notifications/read-all')).status).toBe(200);
    expect((await a.get('/notifications/unread-count')).body.data.unread).toBe(0);
    // preferences: muting a type stops new in-app notifications of that type only
    expect((await a.agent.put('/api/notifications/preferences').set('X-Org-Id', owner.orgId!).send({ prefs: [{ type: 'LEAD_ASSIGNED', inApp: false }] })).status).toBe(200);
    await lead(owner, { assignedToId: a.userId, firstName: 'Muted' });
    expect((await titles(a)).some((t) => /Muted/.test(t))).toBe(false);
    await owner.post('/tasks', { title: 'Still delivered', assignedToId: a.userId });
    expect((await titles(a)).some((t) => /Still delivered/.test(t))).toBe(true);
  });
});
