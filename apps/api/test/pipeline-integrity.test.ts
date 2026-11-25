import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, boot, createWorkspace, ownerPrisma, signUp, uniq, type Actor } from './helpers';

beforeAll(async () => { await boot(); });
const lead = (a: Actor, extra: Record<string, unknown> = {}) => a.post('/leads', { firstName: 'D', email: `d-${uniq()}@x.com`, ...extra });

describe('several deals per lead behave consistently', () => {
  let owner: Actor, agent: Actor, other: Actor;
  let pipe: { id: string; stages: Array<{ id: string; kind: string; name: string }> }, reasons: Array<{ id: string }>;
  const stage = (k: string, i = 0) => pipe.stages.filter((s) => s.kind === k)[i]!.id;
  beforeAll(async () => {
    owner = await createWorkspace(await signUp('Deal Owner'), `Deals ${uniq()}`);
    agent = await addMember(owner, 'SALES_AGENT', 'Deal Agent');
    other = await createWorkspace(await signUp('Deal Other'), `DealsB ${uniq()}`);
    pipe = (await owner.get('/pipelines')).body.data[0];
    reasons = (await owner.get('/lost-reasons')).body.data;
  });

  it('the lead becomes Converted at the FIRST won deal (once), stays Converted while another deal is won, and reverts when no deal is won any more', async () => {
    const l = (await lead(owner)).body.data.id;
    const d1 = (await owner.post('/opportunities', { leadId: l, name: 'Deal 1', value: 100 })).body.data.id;
    const d2 = (await owner.post('/opportunities', { leadId: l, name: 'Deal 2', value: 200 })).body.data.id;
    const d3 = (await owner.post('/opportunities', { leadId: l, name: 'Deal 3', value: 300 })).body.data.id;
    expect((await owner.get(`/opportunities?leadId=${l}`)).body.data).toHaveLength(3);
    const status = async () => (await ownerPrisma.lead.findUniqueOrThrow({ where: { id: l } }));
    expect((await status()).status).not.toBe('CONVERTED');
    expect((await owner.post(`/opportunities/${d1}/move`, { stageId: stage('WON') })).status).toBe(200);
    expect((await status()).status).toBe('CONVERTED'); const when = (await status()).convertedAt;
    expect(when).not.toBeNull();
    expect((await owner.post(`/opportunities/${d2}/move`, { stageId: stage('WON') })).status).toBe(200);
    expect((await status()).convertedAt?.getTime()).toBe(when!.getTime());                                       // not re-stamped
    const conv = await ownerPrisma.activity.count({ where: { leadId: l, title: { startsWith: 'Lead converted' } } });
    expect(conv).toBe(1);                                                                                         // announced once
    expect((await owner.post(`/opportunities/${d3}/move`, { stageId: stage('LOST'), lostReasonId: reasons[0]!.id })).status).toBe(200);
    expect((await status()).status).toBe('CONVERTED');                                                            // a lost sibling does not undo the conversion
    // reopen one won deal: still converted (the other is won); reopen both: no longer converted
    expect((await owner.post(`/opportunities/${d1}/move`, { stageId: stage('OPEN') })).status).toBe(200);
    expect((await status()).status).toBe('CONVERTED');
    expect((await owner.post(`/opportunities/${d2}/move`, { stageId: stage('OPEN') })).status).toBe(200);
    expect((await status()).status).not.toBe('CONVERTED'); expect((await status()).convertedAt).toBeNull();
    // history is complete and ordered for each deal
    const h = await ownerPrisma.stageHistory.findMany({ where: { opportunityId: d1 }, orderBy: { createdAt: 'asc' } });
    expect(h).toHaveLength(3);                                                                                    // created → won → reopened
    expect(h.map((x) => x.toStageId)).toEqual([stage('OPEN'), stage('WON'), stage('OPEN')]);
    expect(h[1]!.fromStageId).toBe(stage('OPEN')); expect(h.every((x) => x.changedById === owner.userId)).toBe(true);
  });

  it('won / lost rules: lost needs a valid reason of this workspace, reopening clears the outcome, new deals start open, values and dates are validated', async () => {
    const l = (await lead(owner)).body.data.id;
    const d = (await owner.post('/opportunities', { leadId: l, name: 'Rules', value: 1000, expectedCloseDate: '2027-05-01' })).body.data;
    expect(d.expectedCloseDate).toContain('2027-05-01');
    const noReason = await owner.post(`/opportunities/${d.id}/move`, { stageId: stage('LOST') });
    expect(noReason.status).toBe(400); expect(noReason.body.error.code).toBe('LOST_REASON_REQUIRED');
    const foreignReason = (await other.get('/lost-reasons')).body.data[0].id;
    expect((await owner.post(`/opportunities/${d.id}/move`, { stageId: stage('LOST'), lostReasonId: foreignReason })).status).toBe(400);
    expect((await owner.post(`/opportunities/${d.id}/move`, { stageId: stage('LOST'), lostReasonId: reasons[1]!.id, lostNote: 'Chose a competitor' })).status).toBe(200);
    let row = await ownerPrisma.opportunity.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ status: 'LOST', lostReasonId: reasons[1]!.id, lostNote: 'Chose a competitor' }); expect(row.lostAt).not.toBeNull(); expect(row.wonAt).toBeNull();
    expect((await owner.post(`/opportunities/${d.id}/move`, { stageId: stage('WON') })).status).toBe(200);      // lost → won directly clears the lost data
    row = await ownerPrisma.opportunity.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ status: 'WON', lostReasonId: null, lostNote: null }); expect(row.lostAt).toBeNull(); expect(row.wonAt).not.toBeNull();
    expect((await owner.post(`/opportunities/${d.id}/move`, { stageId: stage('OPEN') })).status).toBe(200);
    row = await ownerPrisma.opportunity.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ status: 'OPEN', wonAt: null, lostAt: null });
    // creation rules
    expect((await owner.post('/opportunities', { leadId: l, name: 'Born won', value: 1, stageId: stage('WON') })).status).toBe(400);
    expect((await owner.post('/opportunities', { leadId: l, name: 'Negative', value: -5 })).status).toBe(400);
    expect((await owner.post('/opportunities', { leadId: l, name: '', value: 5 })).status).toBe(400);
    expect((await owner.post('/opportunities', { leadId: l, name: 'Huge', value: 1e15 })).status).toBe(400);
    expect((await owner.post('/opportunities', { leadId: l, name: 'Bad date', value: 5, expectedCloseDate: 'someday' })).status).toBe(400);
  });

  it('assignment of deals: the owner must be an active member of the workspace; agents see and move only their own deals', async () => {
    const l = (await lead(owner, { assignedToId: agent.userId })).body.data.id;
    const d = (await agent.post('/opportunities', { leadId: l, name: 'Mine', value: 10 })).body.data;
    expect(d.owner.id).toBe(agent.userId);                                                                       // defaults to the lead's owner
    expect((await owner.patch(`/opportunities/${d.id}`, { ownerId: other.userId })).status).toBeGreaterThanOrEqual(400);
    expect((await owner.patch(`/opportunities/${d.id}`, { ownerId: owner.userId, value: 55 })).status).toBe(200);
    expect((await agent.get(`/opportunities/${d.id}`)).status).toBe(200);                                        // creators keep read access to what they created…
    expect((await agent.patch(`/opportunities/${d.id}`, { value: 1 })).status).toBe(200);
    const own = await owner.post('/opportunities', { leadId: (await lead(owner)).body.data.id, name: 'Owner deal', value: 5 });
    expect((await agent.post(`/opportunities/${own.body.data.id}/move`, { stageId: stage('WON') })).status).toBe(404);
    expect((await agent.get('/opportunities?pageSize=50')).body.data.map((o: { id: string }) => o.id)).not.toContain(own.body.data.id);   // the owner's own deal is not visible to the agent
    expect((await other.get(`/opportunities/${d.id}`)).status).toBe(404);                                        // other workspace
    expect((await other.post(`/opportunities/${d.id}/move`, { stageId: stage('WON') })).status).toBe(404);
    expect((await other.post('/opportunities', { leadId: l, name: 'Cross', value: 1 })).status).toBe(404);
  });

  it('pipelines: customisation, ordering and protection of stages in use; deals can move between pipelines with history; filters work on the table view', async () => {
    const created = await owner.post('/pipelines', { name: 'Enterprise' });
    expect(created.status).toBe(201);
    const p2 = (await owner.get('/pipelines')).body.data.find((p: { name: string }) => p.name === 'Enterprise');
    const added = await owner.post(`/pipelines/${p2.id}/stages`, { name: 'Legal review', probability: 70, kind: 'OPEN' });
    expect(added.status).toBe(201);
    const order = (await owner.get('/pipelines')).body.data.find((p: { id: string }) => p.id === p2.id).stages as Array<{ id: string; name: string; kind: string }>;
    expect(order.at(-2)!.kind).toBe('WON'); expect(order.at(-1)!.kind).toBe('LOST');                            // open stages stay before Won / Lost
    const opens = order.filter((s) => s.kind === 'OPEN');
    const reversed = [...opens].reverse().map((s) => s.id);
    expect((await owner.post(`/pipelines/${p2.id}/stages/reorder`, { stageIds: [...reversed, ...order.filter((s) => s.kind !== 'OPEN').map((s) => s.id)] })).status).toBe(200);
    expect((await owner.post(`/pipelines/${p2.id}/stages/reorder`, { stageIds: [order.at(-1)!.id, ...order.slice(0, -1).map((s) => s.id)] })).status).toBe(400);   // Lost cannot go first
    // a deal moves into the other pipeline; its history records it; the stage cannot then be deleted
    const l = (await lead(owner)).body.data.id;
    const d = (await owner.post('/opportunities', { leadId: l, name: 'Big', value: 5000, pipelineId: p2.id })).body.data;
    expect(d.pipeline?.id ?? d.pipelineId).toBe(p2.id);
    const legal = order.find((s) => s.kind === 'OPEN' && s.id !== d.stage.id)!;
    expect((await owner.post(`/opportunities/${d.id}/move`, { stageId: legal.id })).status).toBe(200);
    expect((await owner.del(`/stages/${legal.id}`)).body.error.code).toBe('STAGE_IN_USE');
    expect((await owner.del(`/pipelines/${p2.id}`)).body.error.code).toBe('PIPELINE_IN_USE');
    expect((await owner.post(`/opportunities/${d.id}/move`, { stageId: stage('OPEN') })).status).toBe(200);       // into the default pipeline
    expect((await ownerPrisma.opportunity.findUniqueOrThrow({ where: { id: d.id } })).pipelineId).toBe(pipe.id);
    const hist = await ownerPrisma.stageHistory.findMany({ where: { opportunityId: d.id }, orderBy: { createdAt: 'asc' } });
    expect(hist).toHaveLength(3);
    // filters on the table view
    await owner.post('/opportunities', { leadId: l, name: 'Searchable zebra', value: 7, ownerId: owner.userId });
    expect((await owner.get('/opportunities?q=zebra')).body.meta.total).toBe(1);
    expect((await owner.get(`/opportunities?status=OPEN&ownerId=${owner.userId}`)).body.meta.total).toBeGreaterThan(0);
    expect((await owner.get(`/opportunities?pipelineId=${p2.id}`)).body.meta.total).toBe(0);
    const zebra = (await owner.get('/opportunities?q=zebra')).body.data[0].id;
    await owner.post(`/opportunities/${zebra}/move`, { stageId: stage('WON') });
    expect((await owner.get('/opportunities?status=WON')).body.meta.total).toBe(1);
    expect((await owner.get('/opportunities?status=OPEN,LOST')).body.data.map((o: { id: string }) => o.id)).not.toContain(zebra);
    // another workspace can use neither our pipeline nor our stages
    expect((await other.post('/opportunities', { leadId: (await lead(other)).body.data.id, name: 'x', value: 1, pipelineId: p2.id })).status).toBeGreaterThanOrEqual(400);
    expect((await other.post(`/pipelines/${p2.id}/stages`, { name: 'Hack' })).status).toBeGreaterThanOrEqual(403);
  });

  it('the board shows exactly the deals of the table, and totals per column add up', async () => {
    const board = (await owner.get('/opportunities/board')).body.data;
    const all = (await owner.get('/opportunities?pipelineId=' + board.pipeline.id + '&pageSize=100')).body;
    expect(board.stages.reduce((a: number, s: { count: number }) => a + s.count, 0)).toBe(all.meta.total);
    expect(board.stages.reduce((a: number, s: { totalValue: number }) => a + s.totalValue, 0)).toBeCloseTo(all.meta.totalValue, 2);
    for (const s of board.stages) expect(s.opportunities.length).toBeLessThanOrEqual(Math.min(s.count, 60));
  });
});
