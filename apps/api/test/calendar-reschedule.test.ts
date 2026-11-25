import { beforeAll, describe, expect, it } from 'vitest';
import { formatInTimeZone } from 'date-fns-tz';
import { resolveNewStart } from '../src/modules/followups/calendar';
import { addMember, boot, createWorkspace, ownerPrisma, signUp, uniq, type Actor } from './helpers';

const TZ = 'America/New_York';
let owner: Actor, manager: Actor, agentA: Actor, agentB: Actor, viewer: Actor, other: Actor;
let leadA: string, leadB: string;
const local = (d: string | Date, f = 'yyyy-MM-dd HH:mm') => formatInTimeZone(new Date(d), TZ, f);
const resched = (a: Actor, body: Record<string, unknown>) => a.post('/calendar/reschedule', body);
const mkFollowUp = async (a: Actor, lead: string, dueAt: string, assignedToId = a.userId) => (await a.post('/followups', { leadId: lead, type: 'CALL', dueAt, assignedToId, priority: 'MEDIUM' })).body.data.id as string;
const mkTask = async (a: Actor, dueAt: string | null, extra: Record<string, unknown> = {}) => (await a.post('/tasks', { title: `Task ${uniq()}`, dueAt, assignedToId: a.userId, ...extra })).body.data.id as string;

beforeAll(async () => {
  await boot();
  owner = await createWorkspace(await signUp('Cal Owner'), `Cal ${uniq()}`);
  expect((await owner.patch('/organizations/current', { timezone: TZ })).status).toBe(200);
  manager = await addMember(owner, 'MANAGER', 'Cal Manager'); agentA = await addMember(owner, 'SALES_AGENT', 'Cal Agent A'); agentB = await addMember(owner, 'SALES_AGENT', 'Cal Agent B'); viewer = await addMember(owner, 'VIEWER', 'Cal Viewer');
  other = await createWorkspace(await signUp('Cal Other'), `CalB ${uniq()}`);
  leadA = (await agentA.post('/leads', { firstName: 'CalA', email: `ca-${uniq()}@x.test` })).body.data.id;
  leadB = (await agentB.post('/leads', { firstName: 'CalB', email: `cb-${uniq()}@x.test` })).body.data.id;
});

describe('resolveNewStart — timezone handling', () => {
  const cur = new Date('2027-03-10T15:00:00Z');             // 10:00 EST (UTC-5)
  it('keeps the wall-clock time in the WORKSPACE timezone across a daylight-saving change', () => {
    const next = resolveNewStart(TZ, cur, { date: '2027-03-15' });   // DST began on 2027-03-14: EDT is UTC-4
    expect(next.toISOString()).toBe('2027-03-15T14:00:00.000Z');
    expect(local(next)).toBe('2027-03-15 10:00');
  });
  it('applies an explicit time, and a date near midnight lands on the right calendar day for the workspace, not for UTC', () => {
    expect(resolveNewStart(TZ, cur, { date: '2027-03-12', time: '23:30' }).toISOString()).toBe('2027-03-13T04:30:00.000Z');   // still the 12th in New York
    expect(resolveNewStart('Pacific/Auckland', new Date('2027-06-01T11:30:00Z'), { date: '2027-06-03' }).toISOString()).toBe('2027-06-03T11:30:00.000Z');
  });
  it('rejects impossible dates instead of rolling over', () => {
    expect(() => resolveNewStart(TZ, cur, { date: '2027-02-30' })).toThrow(/valid date/);
  });
  it('passes an absolute instant through unchanged', () => {
    expect(resolveNewStart(TZ, cur, { start: new Date('2027-05-05T05:05:00Z') }).toISOString()).toBe('2027-05-05T05:05:00.000Z');
  });
});

describe('calendar rescheduling — follow-ups', () => {
  it('moves a follow-up to another day in the workspace timezone, records history and re-arms its reminder', async () => {
    const id = await mkFollowUp(agentA, leadA, '2027-03-10T15:00:00Z');
    await ownerPrisma.followUp.update({ where: { id }, data: { reminderSentAt: new Date(), overdueNotifiedAt: new Date() } });
    const r = await resched(agentA, { kind: 'followup', id, date: '2027-03-15', expectedStart: '2027-03-10T15:00:00Z' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ kind: 'followup', id, changed: true });
    expect(local(r.body.data.start)).toBe('2027-03-15 10:00');            // same wall-clock hour in New York, across DST
    const row = await ownerPrisma.followUp.findUniqueOrThrow({ where: { id } });
    expect(row.dueAt.toISOString()).toBe('2027-03-15T14:00:00.000Z');
    expect(row.rescheduleCount).toBe(1); expect(row.reminderSentAt).toBeNull(); expect(row.overdueNotifiedAt).toBeNull();
    const ev = await ownerPrisma.followUpEvent.findMany({ where: { followUpId: id, type: 'RESCHEDULED' } });
    expect(ev).toHaveLength(1); expect(ev[0]!.fromDueAt?.toISOString()).toBe('2027-03-10T15:00:00.000Z'); expect(ev[0]!.note).toMatch(/calendar/i);
    expect((await agentA.get(`/leads/${leadA}/activities?type=FOLLOWUP_RESCHEDULED`)).body.data).toHaveLength(1);
    // day view: change the time as well
    const t = await resched(agentA, { kind: 'followup', id, date: '2027-03-15', time: '16:30' });
    expect(local(t.body.data.start)).toBe('2027-03-15 16:30');
  });

  it('rejects the past, impossible dates and malformed input; duplicates and stale drops change nothing', async () => {
    const id = await mkFollowUp(agentA, leadA, '2027-04-10T15:00:00Z');
    expect((await resched(agentA, { kind: 'followup', id, start: '2020-01-01T00:00:00Z' })).body.error.code).toBe('IN_THE_PAST');
    expect((await resched(agentA, { kind: 'followup', id, date: '2027-02-30' })).status).toBe(400);
    expect((await resched(agentA, { kind: 'followup', id, date: 'tomorrow' })).status).toBe(400);
    expect((await resched(agentA, { kind: 'followup', id })).status).toBe(400);
    expect((await resched(agentA, { kind: 'followup', id, start: '2027-04-11T15:00:00Z', date: '2027-04-11' })).status).toBe(400);
    expect((await resched(agentA, { kind: 'followup', id, start: '2999-01-01T00:00:00Z' })).status).toBe(400);
    expect((await resched(agentA, { kind: 'followup', id: 'not-a-uuid', date: '2027-04-12' })).status).toBe(400);
    expect((await ownerPrisma.followUp.findUniqueOrThrow({ where: { id } })).rescheduleCount).toBe(0);
    // same drop twice (double click / retry): the first wins, the second is refused as stale — one history entry only
    const body = { kind: 'followup', id, date: '2027-04-14', expectedStart: '2027-04-10T15:00:00Z' };
    const [a, b] = await Promise.all([resched(agentA, body), resched(agentA, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((x) => x.status === 409)!.body.error).toMatchObject({ code: 'STALE_EVENT', details: { currentStart: '2027-04-14T15:00:00.000Z' } });
    expect((await ownerPrisma.followUp.findUniqueOrThrow({ where: { id } })).rescheduleCount).toBe(1);
    // dropping on the day it already has is a harmless no-op
    const same = await resched(agentA, { kind: 'followup', id, date: '2027-04-14' });
    expect(same.status).toBe(200); expect(same.body.data.changed).toBe(false);
    expect((await ownerPrisma.followUp.findUniqueOrThrow({ where: { id } })).rescheduleCount).toBe(1);
  });

  it('only the assignee or a manager can move it; viewers, other agents and other workspaces cannot', async () => {
    const id = await mkFollowUp(agentA, leadA, '2027-05-10T15:00:00Z');
    expect((await resched(agentB, { kind: 'followup', id, date: '2027-05-12' })).status).toBe(404);          // cannot even see it
    expect((await resched(viewer, { kind: 'followup', id, date: '2027-05-12' })).body.error.code).toBe('MISSING_PERMISSION');
    expect((await resched(other, { kind: 'followup', id, date: '2027-05-12' })).status).toBe(404);
    // creator who is not the assignee: A creates a follow-up for B on B's lead
    const forB = await mkFollowUp(agentA, leadB, '2027-05-10T15:00:00Z', agentB.userId).catch(() => null);
    if (forB) {
      const denied = await resched(agentA, { kind: 'followup', id: forB, date: '2027-05-12' });
      expect([403, 404]).toContain(denied.status);
      expect((await ownerPrisma.followUp.findUniqueOrThrow({ where: { id: forB } })).dueAt.toISOString()).toBe('2027-05-10T15:00:00.000Z');
      expect((await resched(agentB, { kind: 'followup', id: forB, date: '2027-05-12' })).status).toBe(200);
    }
    // a manager (can see and manage everyone's) can; the assignee is told
    const before = ((await agentA.get('/notifications')).body.data as unknown[]).length;
    expect((await resched(manager, { kind: 'followup', id, date: '2027-05-13' })).status).toBe(200);
    const notes = (await agentA.get('/notifications')).body.data as Array<{ title: string }>;
    expect(notes.length).toBe(before + 1);
    expect(notes[0]!.title).toMatch(/Cal Manager rescheduled your phone call/);
  });

  it('completed and canceled follow-ups cannot be moved', async () => {
    const done = await mkFollowUp(agentA, leadA, '2027-06-10T15:00:00Z');
    expect((await agentA.post(`/followups/${done}/complete`, { outcome: 'SUCCESSFULLY_CONTACTED' })).status).toBe(200);
    const r = await resched(agentA, { kind: 'followup', id: done, date: '2027-06-12' });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('NOT_RESCHEDULABLE');
    const canceled = await mkFollowUp(agentA, leadA, '2027-06-10T15:00:00Z');
    await agentA.post(`/followups/${canceled}/cancel`, { reason: 'x' });
    expect((await resched(agentA, { kind: 'followup', id: canceled, date: '2027-06-12' })).status).toBe(409);
  });
});

describe('calendar rescheduling — tasks', () => {
  it('moves an open task, re-arms reminder flags and un-overdues a task moved into the future', async () => {
    const id = await mkTask(agentA, '2027-03-10T15:00:00Z');
    await ownerPrisma.task.update({ where: { id }, data: { dueAt: new Date(Date.now() - 3 * 86_400_000), reminderSentAt: new Date(), overdueNotifiedAt: new Date() } });
    const cal0 = (await agentA.get(`/calendar?from=${new Date(Date.now() - 5 * 86_400_000).toISOString()}&to=${new Date(Date.now() + 5 * 86_400_000).toISOString()}&kinds=task`)).body.data as Array<{ id: string; overdue: boolean; canReschedule: boolean }>;
    expect(cal0.find((e) => e.id === id)).toMatchObject({ overdue: true, canReschedule: true });
    const date = formatInTimeZone(new Date(Date.now() + 10 * 86_400_000), TZ, 'yyyy-MM-dd');
    const r = await resched(agentA, { kind: 'task', id, date });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(local(r.body.data.start, 'yyyy-MM-dd')).toBe(date);
    const row = await ownerPrisma.task.findUniqueOrThrow({ where: { id } });
    expect(row.reminderSentAt).toBeNull(); expect(row.overdueNotifiedAt).toBeNull();
    const list = (await agentA.get('/tasks?scope=mine&pageSize=100')).body.data as Array<{ id: string; isOverdue: boolean }>;
    expect(list.find((t) => t.id === id)?.isOverdue).toBe(false);
    expect(await ownerPrisma.auditLog.count({ where: { organizationId: owner.orgId!, action: 'task.rescheduled', entityId: id } })).toBe(1);
  });

  it('refuses completed, canceled and undated tasks, and other people\'s tasks', async () => {
    const done = await mkTask(agentA, '2027-07-10T15:00:00Z');
    await agentA.patch(`/tasks/${done}`, { status: 'DONE' });
    expect((await resched(agentA, { kind: 'task', id: done, date: '2027-07-12' })).body.error.code).toBe('NOT_RESCHEDULABLE');
    const undated = await mkTask(agentA, null);
    expect((await resched(agentA, { kind: 'task', id: undated, date: '2027-07-12' })).body.error.code).toBe('NOT_RESCHEDULABLE');
    const mine = await mkTask(agentA, '2027-07-10T15:00:00Z');
    expect((await resched(agentB, { kind: 'task', id: mine, date: '2027-07-12' })).status).toBe(404);
    expect((await resched(viewer, { kind: 'task', id: mine, date: '2027-07-12' })).body.error.code).toBe('MISSING_PERMISSION');
    expect((await resched(other, { kind: 'task', id: mine, date: '2027-07-12' })).status).toBe(404);
    expect((await resched(manager, { kind: 'task', id: mine, date: '2027-07-12' })).status).toBe(200);
    const notes = (await agentA.get('/notifications')).body.data as Array<{ title: string }>;
    expect(notes.some((n) => /Cal Manager moved the due date/.test(n.title))).toBe(true);
    expect((await ownerPrisma.task.findUniqueOrThrow({ where: { id: done } })).dueAt!.toISOString()).toBe('2027-07-10T15:00:00.000Z');
  });

  it('a task created by one agent and assigned to another can be moved only by the assignee (or a manager)', async () => {
    const t = await mkTask(agentA, '2027-08-10T15:00:00Z', { assignedToId: agentB.userId });
    expect((await resched(agentA, { kind: 'task', id: t, date: '2027-08-12' })).body.error.code).toBe('NOT_ASSIGNEE');
    expect((await resched(agentB, { kind: 'task', id: t, date: '2027-08-12' })).status).toBe(200);
  });

  it('the calendar feed tells the UI what may be dragged', async () => {
    const f = await mkFollowUp(agentA, leadA, '2027-09-10T15:00:00Z');
    const g = await mkFollowUp(agentA, leadA, '2027-09-11T15:00:00Z'); await agentA.post(`/followups/${g}/complete`, { outcome: 'SUCCESSFULLY_CONTACTED' });
    const q = `/calendar?from=2027-09-01T00:00:00Z&to=2027-10-01T00:00:00Z&kinds=followup`;
    const asA = (await agentA.get(q)).body.data as Array<{ id: string; canReschedule: boolean; assigneeId: string }>;
    expect(asA.find((e) => e.id === f)).toMatchObject({ canReschedule: true, assigneeId: agentA.userId });
    expect(asA.find((e) => e.id === g)?.canReschedule).toBe(false);
    expect((await viewer.get(q)).body.data.find((e: { id: string }) => e.id === f).canReschedule).toBe(false);
    expect((await manager.get(q)).body.data.find((e: { id: string }) => e.id === f).canReschedule).toBe(true);
  });
});
