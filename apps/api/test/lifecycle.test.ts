import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, addHours, addMinutes } from 'date-fns';
import { addMember, boot, createWorkspace, signUp, type Actor } from './helpers';
import { runSchedulerTick } from '../src/modules/automations/scheduler';

beforeAll(boot);

describe('end-to-end lead lifecycle (API level)', () => {
  let owner: Actor, manager: Actor, agent: Actor;
  let leadId = '', followUpId = '', oppId = '';
  const dueAt = addHours(new Date(), 3);

  it('owner creates workspace and invites a manager and a sales agent', async () => {
    const o = await signUp('Olivia Owner');
    owner = await createWorkspace(o, 'Lifecycle Realty');
    manager = await addMember(owner, 'MANAGER', 'Mark Manager');
    agent = await addMember(owner, 'SALES_AGENT', 'Sara Sales');
    const team = await owner.get('/members');
    expect(team.body.data).toHaveLength(3);
  });

  it('manager creates a lead and assigns it to the salesperson', async () => {
    const sources = (await manager.get('/lead-sources')).body.data as Array<{ id: string; name: string }>;
    const res = await manager.post('/leads', { firstName: 'Priya', lastName: 'Shah', email: 'Priya.Shah@Example.com', phone: '+1 (415) 555-0142', companyName: 'Shah Interiors', sourceId: sources[0]!.id, assignedToId: agent.userId });
    expect(res.status).toBe(201);
    leadId = res.body.data.id;
    expect(res.body.data.assignedTo.id).toBe(agent.userId);
    const hist = await manager.get(`/leads/${leadId}/assignments`);
    expect(hist.body.data).toHaveLength(1);
  });

  it('rejects duplicates and leads without a contact method', async () => {
    const dup = await manager.post('/leads', { firstName: 'Priya', email: 'priya.shah@example.com' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_LEAD');
    const dupPhone = await manager.post('/leads', { firstName: 'P', phone: '415-555-0142' });
    expect(dupPhone.status).toBe(409);
    const none = await manager.post('/leads', { firstName: 'Nobody' });
    expect(none.status).toBe(400);
  });

  it('salesperson sees the assigned lead; a different agent-less lead stays hidden', async () => {
    expect((await agent.get(`/leads/${leadId}`)).status).toBe(200);
    const other = await manager.post('/leads', { firstName: 'Hidden', email: 'hidden@example.com' });
    const list = await agent.get('/leads');
    expect(list.body.data.map((l: { id: string }) => l.id)).toContain(leadId);
    expect(list.body.data.map((l: { id: string }) => l.id)).not.toContain(other.body.data.id);
    expect((await agent.get(`/leads/${other.body.data.id}`)).status).toBe(404);
  });

  it('salesperson logs a call and schedules a follow-up that shows in the calendar', async () => {
    const call = await agent.post(`/leads/${leadId}/activities`, { type: 'CALL', body: 'Introduced the offer', durationMinutes: 6, direction: 'OUTBOUND' });
    expect(call.status).toBe(201);
    const detail = await agent.get(`/leads/${leadId}`);
    expect(detail.body.data.status).toBe('CONTACTED');
    expect(detail.body.data.firstContactedAt).toBeTruthy();

    const fu = await agent.post('/followups', { leadId, type: 'CALL', dueAt: dueAt.toISOString(), notes: 'Discuss quote', priority: 'HIGH' });
    expect(fu.status).toBe(201);
    followUpId = fu.body.data.id;
    const past = await agent.post('/followups', { leadId, dueAt: addDays(new Date(), -1).toISOString() });
    expect(past.status).toBe(400);

    const cal = await agent.get(`/calendar?from=${addDays(new Date(), -1).toISOString()}&to=${addDays(new Date(), 2).toISOString()}`);
    expect(cal.body.data.some((e: { id: string; kind: string }) => e.id === followUpId && e.kind === 'followup')).toBe(true);
  });

  it('background scheduler generates the reminder and, later, the overdue notification', async () => {
    await runSchedulerTick(addMinutes(dueAt, -5));
    let notes = await agent.get('/notifications');
    expect(notes.body.data.some((n: { type: string }) => n.type === 'FOLLOWUP_DUE')).toBe(true);
    await runSchedulerTick(addMinutes(dueAt, 30));
    notes = await agent.get('/notifications');
    expect(notes.body.data.some((n: { type: string }) => n.type === 'FOLLOWUP_OVERDUE')).toBe(true);
    // running again does not duplicate
    const before = notes.body.meta.total;
    await runSchedulerTick(addMinutes(dueAt, 31));
    expect((await agent.get('/notifications')).body.meta.total).toBe(before);
    const unread = await agent.get('/notifications/unread-count');
    expect(unread.body.data.unread).toBeGreaterThan(0);
  });

  it('completing requires an outcome and records who/when; next follow-up can be scheduled', async () => {
    const bad = await agent.post(`/followups/${followUpId}/complete`, {});
    expect(bad.status).toBe(400);
    const ok = await agent.post(`/followups/${followUpId}/complete`, { outcome: 'INTERESTED', outcomeNotes: 'Wants a proposal', next: { dueAt: addDays(new Date(), 2).toISOString(), type: 'MEETING', notes: 'Proposal review' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.nextFollowUpId).toBeTruthy();
    const d = await agent.get(`/followups/${followUpId}`);
    expect(d.body.data.status).toBe('COMPLETED');
    expect(d.body.data.outcome).toBe('INTERESTED');
    expect(d.body.data.completedBy.id).toBe(agent.userId);
    expect(d.body.data.completedAt).toBeTruthy();
    expect((await agent.post(`/followups/${followUpId}/complete`, { outcome: 'OTHER' })).status).toBe(400);
  });

  it('rescheduling preserves history', async () => {
    const list = await agent.get(`/followups?view=pending&leadId=${leadId}`);
    const next = list.body.data[0];
    const r = await agent.post(`/followups/${next.id}/reschedule`, { dueAt: addDays(new Date(), 4).toISOString(), reason: 'Client travelling' });
    expect(r.status).toBe(200);
    const d = await agent.get(`/followups/${next.id}`);
    expect(d.body.data.rescheduleCount).toBe(1);
    expect(d.body.data.events.map((e: { type: string }) => e.type)).toEqual(['CREATED', 'RESCHEDULED']);
  });

  it('opportunity moves through the pipeline and is won; lead converts', async () => {
    const pipelines = (await agent.get('/pipelines')).body.data;
    const stages = pipelines[0].stages as Array<{ id: string; name: string; kind: string }>;
    const opp = await agent.post('/opportunities', { leadId, name: 'Shah Interiors — fit-out', value: 12500 });
    expect(opp.status).toBe(201);
    oppId = opp.body.data.id;
    expect(opp.body.data.stage.name).toBe('New');
    const q = stages.find((s) => s.name === 'Qualified')!, won = stages.find((s) => s.kind === 'WON')!, lost = stages.find((s) => s.kind === 'LOST')!;
    expect((await agent.post(`/opportunities/${oppId}/move`, { stageId: q.id })).status).toBe(200);
    const noReason = await agent.post(`/opportunities/${oppId}/move`, { stageId: lost.id });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('LOST_REASON_REQUIRED');
    expect((await agent.post(`/opportunities/${oppId}/move`, { stageId: won.id })).status).toBe(200);
    const d = await agent.get(`/opportunities/${oppId}`);
    expect(d.body.data.status).toBe('WON');
    expect(d.body.data.wonAt).toBeTruthy();
    expect(d.body.data.history.map((h: { to: string }) => h.to)).toEqual(['Won', 'Qualified', 'New']);
    const lead = await agent.get(`/leads/${leadId}`);
    expect(lead.body.data.status).toBe('CONVERTED');
    expect(lead.body.data.opportunities).toHaveLength(1);
  });

  it('one lead can have multiple opportunities; losing one records the reason', async () => {
    const opp2 = await agent.post('/opportunities', { leadId, name: 'Shah — maintenance contract', value: 900 });
    const lostStage = (await agent.get('/pipelines')).body.data[0].stages.find((s: { kind: string }) => s.kind === 'LOST');
    const reasons = (await agent.get('/lost-reasons')).body.data;
    const r = await agent.post(`/opportunities/${opp2.body.data.id}/move`, { stageId: lostStage.id, lostReasonId: reasons[0].id, lostNote: 'Budget' });
    expect(r.status).toBe(200);
    const d = await agent.get(`/opportunities/${opp2.body.data.id}`);
    expect(d.body.data.status).toBe('LOST');
    expect(d.body.data.lostReason.id).toBe(reasons[0].id);
    expect((await agent.get(`/leads/${leadId}`)).body.data.status).toBe('CONVERTED'); // one won deal keeps it converted
  });

  it('activity history reflects all important changes', async () => {
    const t = await agent.get(`/leads/${leadId}/activities?pageSize=100`);
    const types = t.body.data.map((a: { type: string }) => a.type);
    for (const need of ['LEAD_CREATED', 'LEAD_ASSIGNED', 'CALL', 'FOLLOWUP_SCHEDULED', 'FOLLOWUP_COMPLETED', 'FOLLOWUP_RESCHEDULED', 'OPPORTUNITY_CREATED', 'STAGE_CHANGED', 'OPPORTUNITY_WON', 'OPPORTUNITY_LOST']) expect(types).toContain(need);
    expect(t.body.data.every((a: { actor: unknown; occurredAt: string }) => a.occurredAt)).toBe(true);
  });

  it('dashboard and reports reflect the real data (and scope for agents)', async () => {
    const dm = await manager.get('/dashboard?range=last_30_days');
    expect(dm.status).toBe(200);
    expect(dm.body.data.kpis.totalLeads).toBeGreaterThanOrEqual(2);
    expect(dm.body.data.kpis.wonOpportunities).toBe(1);
    expect(dm.body.data.kpis.lostOpportunities).toBe(1);
    expect(dm.body.data.kpis.conversionRate).toBe(50);
    expect(dm.body.data.kpis.wonValue).toBe(12500);
    const da = await agent.get('/dashboard?range=last_30_days');
    expect(da.body.data.filters.restricted).toBe(true);
    expect(da.body.data.kpis.totalLeads).toBe(1);
    const conv = await manager.get('/reports/conversion?range=last_30_days');
    expect(conv.body.data.summary.find((s: { label: string }) => s.label === 'Conversion rate').value).toBe(50);
    const sp = await manager.get('/reports/salesperson?range=last_30_days');
    const row = sp.body.data.rows.find((r: { id: string }) => r.id === agent.userId);
    expect(row.won).toBe(1);
    expect(row.wonValue).toBe(12500);
    for (const key of ['lead-generation', 'lead-source', 'assignment', 'contact-performance', 'follow-up', 'pipeline', 'lost-leads', 'lead-aging', 'response-time']) {
      const r = await manager.get(`/reports/${key}?range=last_30_days`);
      expect(r.status, key).toBe(200);
    }
    const csv = await manager.get('/reports/lead-source?range=last_30_days&format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
  });
});
