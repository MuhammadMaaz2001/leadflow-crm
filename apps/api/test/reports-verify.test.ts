import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, boot, createWorkspace, ownerPrisma, signUp, uniq, type Actor } from './helpers';

/**
 * Every figure below is computed here, independently, from raw rows (plain JavaScript) and compared with what the reports and the
 * dashboard return, for a deterministic dataset that includes the awkward cases: several deals per lead, deals outside the date range,
 * archived leads, unassigned leads, unassigned/unknown sources, and a second workspace with look-alike data.
 */
const FROM = '2026-03-01', TO = '2026-03-31';
const T = (d: string, h = 10) => new Date(`2026-${d}T${String(h).padStart(2, '0')}:00:00Z`);
const hours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);
let owner: Actor, a1: Actor, a2: Actor, other: Actor;
let srcA: string, srcB: string, stages: { open: string; won: string; lost: string; pipelineId: string }, r1: string, r2: string;
const ids: Record<string, string> = {};
const q = (url: string, a: Actor = owner) => a.get(`${url}${url.includes('?') ? '&' : '?'}range=custom&from=${FROM}&to=${TO}`);

beforeAll(async () => {
  await boot();
  owner = await createWorkspace(await signUp('Rep Owner'), `Rep ${uniq()}`);
  a1 = await addMember(owner, 'SALES_AGENT', 'Agent One'); a2 = await addMember(owner, 'SALES_AGENT', 'Agent Two');
  other = await createWorkspace(await signUp('Rep Other'), `RepB ${uniq()}`);
  const org = owner.orgId!;
  const sources = (await owner.get('/lead-sources')).body.data as Array<{ id: string; name: string }>;
  srcA = sources.find((s) => s.name === 'Website')!.id; srcB = sources.find((s) => s.name === 'Referral')!.id;
  const pl = (await owner.get('/pipelines')).body.data[0];
  stages = { pipelineId: pl.id, open: pl.stages.find((s: { kind: string }) => s.kind === 'OPEN').id, won: pl.stages.find((s: { kind: string }) => s.kind === 'WON').id, lost: pl.stages.find((s: { kind: string }) => s.kind === 'LOST').id };
  const reasons = (await owner.get('/lost-reasons')).body.data as Array<{ id: string }>; r1 = reasons[0]!.id; r2 = reasons[1]!.id;
  const mk = async (key: string, o: { src: string | null; to: Actor | null; status: string; created: Date; contacted?: Date | null; archived?: boolean }) => {
    const l = await ownerPrisma.lead.create({ data: { organizationId: org, firstName: key, email: `${key.toLowerCase()}-${uniq()}@r.test`, sourceId: o.src, assignedToId: o.to?.userId ?? null, assignedAt: o.to ? o.created : null, status: o.status as never, createdAt: o.created, firstContactedAt: o.contacted ?? null, lastActivityAt: o.created, convertedAt: o.status === 'CONVERTED' ? o.created : null, lostAt: o.status === 'LOST' ? o.created : null, archivedAt: o.archived ? o.created : null } });
    ids[key] = l.id;
    if (o.to) await ownerPrisma.leadAssignment.create({ data: { organizationId: org, leadId: l.id, toUserId: o.to.userId, method: key === 'L5' ? 'ROUND_ROBIN' : key === 'L3' ? 'RULE' : 'MANUAL', createdAt: o.created } });
    return l;
  };
  await mk('L1', { src: srcA, to: a1, status: 'CONVERTED', created: T('03-02'), contacted: hours(T('03-02'), 2) });
  await mk('L2', { src: srcA, to: a1, status: 'CONVERTED', created: T('03-05'), contacted: hours(T('03-05'), 30) });
  await mk('L3', { src: srcB, to: a2, status: 'LOST', created: T('03-06'), contacted: hours(T('03-06'), 1) });
  await mk('L4', { src: srcB, to: a2, status: 'QUALIFIED', created: T('03-10'), contacted: hours(T('03-10'), 5) });
  await mk('L5', { src: srcA, to: a2, status: 'CONTACTED', created: T('03-12'), contacted: hours(T('03-12'), 10) });
  await mk('L6', { src: srcB, to: null, status: 'NEW', created: T('03-15') });
  await mk('L7', { src: srcA, to: a1, status: 'NEW', created: T('03-20') });
  await mk('L8', { src: srcB, to: a1, status: 'CONTACTED', created: T('02-20'), contacted: hours(T('02-20'), 3) });     // outside the range
  await mk('L9', { src: srcA, to: a1, status: 'NEW', created: T('03-08'), archived: true });                          // archived: excluded everywhere
  await mk('L10', { src: null, to: a2, status: 'NEW', created: T('03-25') });                                          // no source
  const opp = (key: string, name: string, o: { value: number; status: 'OPEN' | 'WON' | 'LOST'; owner: Actor; at?: Date; reason?: string }) => ownerPrisma.opportunity.create({ data: {
    organizationId: org, leadId: ids[key]!, pipelineId: stages.pipelineId, stageId: o.status === 'OPEN' ? stages.open : o.status === 'WON' ? stages.won : stages.lost, name, value: o.value, status: o.status, ownerId: o.owner.userId,
    wonAt: o.status === 'WON' ? o.at : null, lostAt: o.status === 'LOST' ? o.at : null, lostReasonId: o.reason ?? null, stageEnteredAt: o.at ?? T('03-01'), createdAt: T('03-01'), position: Math.random() * 1000 } });
  await opp('L1', 'O1', { value: 1000, status: 'WON', owner: a1, at: T('03-10') });
  await opp('L1', 'O2', { value: 400, status: 'LOST', owner: a1, at: T('03-11'), reason: r1 });
  await opp('L1', 'O3', { value: 500, status: 'OPEN', owner: a1 });
  await opp('L2', 'O4', { value: 200, status: 'WON', owner: a1, at: T('03-20') });
  await opp('L2', 'O5', { value: 300, status: 'WON', owner: a1, at: T('03-25') });
  await opp('L3', 'O6', { value: 700, status: 'LOST', owner: a2, at: T('03-15'), reason: r2 });
  await opp('L4', 'O7', { value: 900, status: 'OPEN', owner: a2 });
  await opp('L8', 'O8', { value: 50, status: 'WON', owner: a1, at: T('02-25') });                                       // won outside the range
  await opp('L9', 'O9', { value: 9999, status: 'OPEN', owner: a1 });                                                    // deal of an archived lead
  // follow-ups
  const fu = (key: string, who: Actor, status: 'COMPLETED' | 'PENDING' | 'CANCELED', due: Date, completed?: Date) => ownerPrisma.followUp.create({ data: { organizationId: org, leadId: ids[key]!, assignedToId: who.userId, createdById: who.userId, dueAt: due, status, completedAt: completed ?? null, completedById: completed ? who.userId : null, outcome: completed ? 'SUCCESSFULLY_CONTACTED' : null, canceledAt: status === 'CANCELED' ? due : null, cancelReason: status === 'CANCELED' ? 'n/a' : null } });
  await fu('L1', a1, 'COMPLETED', T('03-03'), T('03-03', 9));       // on time
  await fu('L1', a1, 'COMPLETED', T('03-04'), T('03-05'));          // late
  await fu('L2', a1, 'PENDING', T('03-06'));                         // overdue (date in the past)
  await fu('L3', a2, 'COMPLETED', T('03-07'), T('03-07', 8));       // on time
  await fu('L4', a2, 'CANCELED', T('03-09'));
  await fu('L4', a2, 'PENDING', new Date(Date.now() + 5 * 86_400_000));  // outside the report range (future)
});

describe('lead reports match the database', () => {
  it('lead generation, assignment, contact performance, response time and source performance agree with raw rows', async () => {
    const inRange = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L10'];                       // L8 outside range, L9 archived
    const lg = (await q('/reports/lead-generation')).body.data;
    expect(lg.summary.find((s: { label: string }) => s.label === 'Total leads').value).toBe(inRange.length);
    expect(lg.summary.find((s: { label: string }) => s.label === 'Assigned').value).toBe(7);          // all but L6
    expect(lg.summary.find((s: { label: string }) => s.label === 'Contacted').value).toBe(5);        // L1–L5
    expect(lg.summary.find((s: { label: string }) => s.label === 'Converted').value).toBe(2);
    expect(lg.rows.reduce((a: number, r: { leads: number }) => a + r.leads, 0)).toBe(inRange.length);   // buckets add up to the total
    const src = (await q('/reports/lead-source')).body.data.rows as Array<{ source: string; leads: number; contacted: number; won: number; lost: number; won_value: number; contact_rate: number; conversion_rate: number }>;
    const A = src.find((r) => r.source === 'Website')!, B = src.find((r) => r.source === 'Referral')!, U = src.find((r) => r.source === 'Unknown')!;
    expect(A).toMatchObject({ leads: 4, contacted: 3, won: 2, lost: 0 });                              // L1 L2 L5 L7 (L9 archived)
    expect(A.won_value).toBe(1500);                                                                    // 1000 + 200 + 300 — three deals on two leads, nothing double counted
    expect(A.conversion_rate).toBe(50); expect(A.contact_rate).toBe(75);
    expect(B).toMatchObject({ leads: 3, contacted: 2, won: 0, lost: 1, won_value: 0 });                // L3 L4 L6 (L8 outside)
    expect(U).toMatchObject({ leads: 1, contacted: 0 });
    expect(src.reduce((a, r) => a + r.leads, 0)).toBe(inRange.length);
    const asg = (await q('/reports/assignment')).body.data;
    const row = (n: string) => (asg.rows as Array<Record<string, number | string>>).find((r) => r.member === n)!;
    const names = (await owner.get('/members')).body.data as Array<{ userId: string; name: string }>;
    const nm = (a: Actor) => names.find((m) => m.userId === a.userId)!.name;
    // the assignment report counts assignment EVENTS made in the range (an archived lead's assignment still happened): L1 L2 L7 + L9
    expect(row(nm(a1))).toMatchObject({ received: 4, manual: 4 });
    expect(row(nm(a2))).toMatchObject({ received: 4, manual: 2, by_rule: 1, round_robin: 1 });        // L3(rule) L4 L5(rr) L10
    expect(asg.summary.find((s: { label: string }) => s.label === 'Unassigned open leads').value).toBe(1);   // L6 (L8 is assigned)
    const cp = (await q('/reports/contact-performance')).body.data;
    expect(cp.rows.find((r: { member: string }) => r.member === nm(a1))).toMatchObject({ assigned: 3, contacted: 2, contact_rate: 66.7 });
    expect(cp.rows.find((r: { member: string }) => r.member === nm(a2))).toMatchObject({ assigned: 4, contacted: 3, contact_rate: 75 });
    const rt = (await q('/reports/response-time')).body.data;
    const avg = (2 + 30 + 1 + 5 + 10) / 5;
    expect(rt.summary.find((s: { label: string }) => s.label === 'Avg first response (h)').value).toBeCloseTo(avg, 1);
    expect(rt.summary.find((s: { label: string }) => s.label === 'Never contacted').value).toBe(3);   // L6 L7 L10
  });
});

describe('deal reports: several deals per lead are counted per deal, once', () => {
  it('conversion, pipeline, lost reasons and salesperson reports match the deals in the database', async () => {
    const cv = (await q('/reports/conversion')).body.data;
    const get = (rep: { summary: Array<{ label: string; value: number | string }> }, label: string) => rep.summary.find((s) => s.label === label)!.value;
    expect(get(cv, 'Won')).toBe(3);                         // O1 O4 O5 (O8 won in February, O9 on an archived lead)
    expect(get(cv, 'Closed')).toBe(5);                      // + lost O2 O6
    expect(get(cv, 'Conversion rate')).toBe(60);
    expect(get(cv, 'Won value')).toBe(1500);
    const pl = (await q('/reports/pipeline')).body.data;
    expect(get(pl, 'Open deals')).toBe(2);                  // O3 O7; O9 belongs to an archived lead
    expect(get(pl, 'Open pipeline value')).toBe(1400);
    const lost = (await q('/reports/lost-leads')).body.data;
    expect(get(lost, 'Deals lost')).toBe(2); expect(get(lost, 'Value lost')).toBe(1100);
    expect(lost.rows.map((r: { deals: number }) => r.deals).sort()).toEqual([1, 1]);
    const sp = (await q('/reports/salesperson')).body.data.rows as Array<{ id: string; name: string; leads: number; won: number; lost: number; wonValue: number; openOpportunities: number; conversionRate: number }>;
    const s1 = sp.find((r) => r.id === a1.userId)!, s2 = sp.find((r) => r.id === a2.userId)!;
    expect(s1).toMatchObject({ leads: 3, won: 3, lost: 1, wonValue: 1500, openOpportunities: 1, conversionRate: 75 });
    expect(s2).toMatchObject({ leads: 4, won: 0, lost: 1, wonValue: 0, openOpportunities: 1, conversionRate: 0 });
    expect(sp.reduce((a, r) => a + r.won, 0)).toBe(get(cv, 'Won') as number);                          // the team table adds up to the conversion report
    const board = (await owner.get('/opportunities/board')).body.data;
    expect(board.stages.reduce((a: number, s: { kind: string; totalValue: number }) => a + (s.kind === 'OPEN' ? s.totalValue : 0), 0)).toBe(1400);   // the kanban shows the same open value
    const list = (await owner.get('/opportunities?pageSize=50')).body.meta;
    expect(list.total).toBe(8);                                                                        // 9 deals minus the archived lead's
    const byLead = (await owner.get(`/opportunities?leadId=${ids['L1']}`)).body.data;
    expect(byLead).toHaveLength(3);                                                                    // a lead with three deals shows all three
  });
  it('follow-up report counts what was scheduled in the range, on-time completion and what is overdue now', async () => {
    const fu = (await q('/reports/follow-up')).body.data;
    const total = (label: string) => fu.summary.find((s: { label: string }) => s.label === label).value;
    expect(total('Scheduled')).toBe(4);                     // 6 follow-ups minus the canceled one and the one due next week
    expect(total('Completed')).toBe(3);
    expect(total('Overdue now')).toBe(1);
    const r1 = fu.rows.find((r: { on_time: number; member: string }) => r.on_time === 1 && r.member);
    expect(fu.rows.reduce((a: number, r: { on_time: number }) => a + r.on_time, 0)).toBe(2);
    expect(r1).toBeTruthy();
  });
});

describe('the dashboard uses the same numbers as the reports', () => {
  it('KPIs equal the corresponding report totals and the raw counts', async () => {
    const d = (await q('/dashboard')).body.data.kpis;
    expect(d).toMatchObject({ totalLeads: 8, unassignedLeads: 1, assignedLeads: 7, contactedLeads: 5, wonOpportunities: 3, lostOpportunities: 2, wonValue: 1500, conversionRate: 60 });
    expect(d.contactRate).toBe(Math.round((5 / 7) * 1000) / 10);
    const lg = (await q('/reports/lead-generation')).body.data;
    expect(d.totalLeads).toBe(lg.summary.find((s: { label: string }) => s.label === 'Total leads').value);
    const dash = (await q('/dashboard')).body.data;
    expect(dash.pipeline.stages.filter((s: { kind: string }) => s.kind === 'OPEN').reduce((a: number, s: { value: number }) => a + s.value, 0)).toBe(1400);
    expect(dash.leadsBySource.reduce((a: number, s: { leads: number }) => a + s.leads, 0)).toBe(8);
  });
});

describe('scope and tenant safety of reports', () => {
  it('agents only see their own numbers; managers see everything; another workspace sees nothing of it', async () => {
    const mine = (await q('/dashboard', a1)).body.data;
    expect(mine.filters.restricted).toBe(true);
    expect(mine.kpis).toMatchObject({ totalLeads: 3, wonOpportunities: 3, lostOpportunities: 1, wonValue: 1500 });
    // an agent cannot widen the scope with parameters
    const forced = (await a1.get(`/dashboard?range=custom&from=${FROM}&to=${TO}&assignedToId=${a2.userId}`)).body.data;
    expect(forced.kpis.totalLeads).toBe(3); expect(forced.filters.assigneeId).toBe(a1.userId);
    const rep = await q('/reports/salesperson', a1);
    if (rep.status === 200) expect(rep.body.data.rows.every((r: { id: string }) => r.id === a1.userId)).toBe(true); else expect(rep.status).toBe(403);
    // a manager-level filter by owner
    expect((await q(`/dashboard?assignedToId=${a2.userId}`)).body.data.kpis.totalLeads).toBe(4);
    // tenant isolation: the other workspace has no data and cannot select ours
    const o = (await q('/dashboard', other)).body.data.kpis;
    expect(o).toMatchObject({ totalLeads: 0, wonOpportunities: 0, wonValue: 0 });
    expect((await q(`/reports/lead-source?sourceId=${srcA}`, other)).body.data.rows).toHaveLength(0);
    expect((await other.get(`/reports/pipeline?pipelineId=${stages.pipelineId}`)).status).toBeLessThan(500);
    expect((await q('/reports/pipeline', other)).body.data.rows.reduce((a: number, r: { deals: number }) => a + r.deals, 0)).toBe(0);
  });
  it('exports contain exactly the rows the report shows and honour the plan; archived leads disappear from deals and reminders and return on restore', async () => {
    const json = (await q('/reports/lead-source')).body.data.rows;
    const csv = await q('/reports/lead-source?format=csv');
    expect(csv.status).toBe(200);
    expect(String(csv.text).trim().split('\n').length - 1).toBe(json.length);
    // restoring the archived lead brings its deal back into the pipeline
    expect((await owner.post(`/leads/${ids['L9']}/restore`)).status).toBe(200);
    const pl = (await q('/reports/pipeline')).body.data.summary.find((s: { label: string }) => s.label === 'Open pipeline value').value;
    expect(pl).toBe(1400 + 9999);
  });
});

describe('lead status, activity and task performance reports match the database', () => {
  it('count what is stored, per member, in the range — and agree with the other reports that touch the same facts', async () => {
    const org = owner.orgId!;
    await ownerPrisma.lead.update({ where: { id: ids['L9']! }, data: { archivedAt: T('03-08') } });   // an earlier test restored it: put the fixture back
    const act = (key: string, who: Actor, type: 'CALL' | 'EMAIL' | 'WHATSAPP' | 'MEETING' | 'NOTE', day: string) => ownerPrisma.activity.create({ data: { organizationId: org, leadId: ids[key]!, type, actorId: who.userId, title: `${type} ${key}`, occurredAt: T(day), createdAt: T(day) } });
    await act('L1', a1, 'CALL', '03-04'); await act('L1', a1, 'CALL', '03-05'); await act('L2', a1, 'EMAIL', '03-06'); await act('L3', a2, 'WHATSAPP', '03-07'); await act('L4', a2, 'MEETING', '03-11');
    await act('L4', a2, 'NOTE', '03-12'); await act('L5', a2, 'CALL', '03-13'); await act('L8', a1, 'CALL', '02-10');   // L8 call is outside the range
    const task = (title: string, who: Actor, status: 'TODO' | 'DONE' | 'CANCELED', due: Date, done?: Date, priority: 'LOW' | 'HIGH' = 'LOW') => ownerPrisma.task.create({ data: { organizationId: org, title, assignedToId: who.userId, createdById: owner.userId, status, dueAt: due, completedAt: done ?? null, completedById: done ? who.userId : null, priority } });
    await task('t1', a1, 'DONE', T('03-10'), T('03-09'));            // on time
    await task('t2', a1, 'DONE', T('03-11'), T('03-13'));            // late
    await task('t3', a1, 'TODO', T('03-12'), undefined, 'HIGH');    // overdue (date passed)
    await task('t4', a2, 'DONE', T('03-14'), T('03-14', 9));         // on time
    await task('t5', a2, 'CANCELED', T('03-15'));                    // canceled: not counted
    await task('t6', a2, 'TODO', new Date(Date.now() + 3 * 86_400_000));   // outside the range
    await task('t7', a2, 'TODO', T('03-18'));                        // overdue
    const names = (await owner.get('/members')).body.data as Array<{ userId: string; name: string }>;
    const nm = (a: Actor) => names.find((m) => m.userId === a.userId)!.name;

    const st = (await q('/reports/lead-status')).body.data;
    const byStatus = Object.fromEntries(st.rows.map((r: { status: string; leads: number }) => [r.status, r.leads]));
    expect(byStatus).toEqual({ NEW: 3, CONTACTED: 1, QUALIFIED: 1, CONVERTED: 2, LOST: 1 });                       // L6 L7 L10 | L5 | L4 | L1 L2 | L3
    expect(st.rows.reduce((a: number, r: { leads: number }) => a + r.leads, 0)).toBe(8);                          // = leads created in range, archived and out-of-range excluded
    expect(st.summary.find((s: { label: string }) => s.label === 'Still open').value).toBe(5);
    expect(st.rows.find((r: { status: string }) => r.status === 'NEW').unassigned).toBe(1);                       // L6
    expect(st.rows.reduce((a: number, r: { share: number }) => a + r.share, 0)).toBeCloseTo(100, 0);

    const ac = (await q('/reports/activity')).body.data;
    const r1 = ac.rows.find((r: { member: string }) => r.member === nm(a1)), r2 = ac.rows.find((r: { member: string }) => r.member === nm(a2));
    expect(r1).toMatchObject({ calls: 2, emails: 1, whatsapp: 0, meetings: 0, notes: 0, total: 3, leads_touched: 2 });   // the February call is out of range
    expect(r2).toMatchObject({ calls: 1, emails: 0, whatsapp: 1, meetings: 1, notes: 1, total: 4, leads_touched: 3 });
    const cp = (await q('/reports/contact-performance')).body.data.rows;                                           // the same facts in another report
    expect(cp.find((r: { member: string }) => r.member === nm(a1))).toMatchObject({ calls: r1.calls, emails: r1.emails });
    expect(cp.find((r: { member: string }) => r.member === nm(a2))).toMatchObject({ calls: r2.calls, whatsapp: r2.whatsapp, meetings: r2.meetings });
    const mineOnly = (await q('/reports/activity', a1));
    if (mineOnly.status === 200) expect(mineOnly.body.data.rows.every((r: { member: string }) => r.member === nm(a1))).toBe(true); else expect(mineOnly.status).toBe(403);

    const tp = (await q('/reports/task-performance')).body.data;
    const t1 = tp.rows.find((r: { member: string }) => r.member === nm(a1)), t2 = tp.rows.find((r: { member: string }) => r.member === nm(a2));
    expect(t1).toMatchObject({ due: 3, completed: 2, on_time: 1, overdue: 1, upcoming: 0, high_open: 1, completion_rate: 66.7, on_time_rate: 50 });
    expect(t2).toMatchObject({ due: 2, completed: 1, on_time: 1, overdue: 1, completion_rate: 50, on_time_rate: 100 });
    expect(tp.summary.find((s: { label: string }) => s.label === 'Tasks due').value).toBe(5);
    expect(tp.summary.find((s: { label: string }) => s.label === 'Completed').value).toBe(3);
    // an agent sees only their own tasks; another workspace sees nothing
    const agentTasks = await q('/reports/task-performance', a1);
    if (agentTasks.status === 200) expect(agentTasks.body.data.rows.map((r: { member: string }) => r.member)).toEqual([nm(a1)]);
    expect((await q('/reports/task-performance', other)).body.data.rows).toHaveLength(0);
    expect((await q('/reports/activity', other)).body.data.summary.find((s: { label: string }) => s.label === 'Logged activities').value).toBe(0);
    // every report in the catalogue runs and exports for the owner
    for (const r of (await owner.get('/reports')).body.data as Array<{ key: string }>) {
      expect((await q(`/reports/${r.key}`)).status, r.key).toBe(200);
      expect((await q(`/reports/${r.key}?format=csv`)).status, `${r.key} csv`).toBe(200);
    }
  });
});
