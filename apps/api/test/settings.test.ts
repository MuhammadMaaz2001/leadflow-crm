import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, boot, createWorkspace, signUp, type Actor } from './helpers';

beforeAll(boot);

describe('workspace configuration', () => {
  let owner: Actor, manager: Actor;
  beforeAll(async () => { owner = await createWorkspace(await signUp('Config Owner'), 'Config Co'); manager = await addMember(owner, 'MANAGER'); });

  it('tags and custom fields are applied to leads and validated', async () => {
    const tag = (await owner.post('/tags', { name: 'VIP', color: '#ff0000' })).body.data;
    const dupTag = await owner.post('/tags', { name: 'VIP' });
    expect(dupTag.status).toBe(409);
    expect((await owner.post('/custom-fields', { label: 'Budget', type: 'NUMBER', required: true })).status).toBe(201);
    expect((await owner.post('/custom-fields', { label: 'Property type', type: 'SELECT', options: ['House', 'Flat'] })).status).toBe(201);
    expect((await owner.post('/custom-fields', { label: 'Broken', type: 'SELECT' })).status).toBe(400);
    const missing = await owner.post('/leads', { firstName: 'No', email: 'nobudget@x.com' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.fields['customFields.budget']).toMatch(/required/);
    const bad = await owner.post('/leads', { firstName: 'Bad', email: 'bad@x.com', customFields: { budget: 'lots', property_type: 'Castle' } });
    expect(bad.status).toBe(400);
    const ok = await owner.post('/leads', { firstName: 'Ok', email: 'ok@x.com', tagIds: [tag.id], customFields: { budget: '250000', property_type: 'House' } });
    expect(ok.status).toBe(201);
    expect(ok.body.data.tags.map((t: { name: string }) => t.name)).toEqual(['VIP']);
    expect(ok.body.data.customFields).toMatchObject({ budget: 250000, property_type: 'House' });
    const filtered = await owner.get(`/leads?tagId=${tag.id}`);
    expect(filtered.body.meta.total).toBe(1);
    // in-use tag is deactivated, not deleted
    const del = await owner.del(`/tags/${tag.id}`);
    expect(del.body.data.deactivated).toBe(true);
    expect((await owner.get('/tags')).body.data).toHaveLength(0);
    expect((await owner.get('/tags?includeInactive=true')).body.data).toHaveLength(1);
  });

  it('lead listing supports search, filters, sorting and pagination', async () => {
    const prios = (await owner.get('/lead-priorities')).body.data as Array<{ id: string; name: string }>;
    await owner.patch('/custom-fields/' + (await owner.get('/custom-fields')).body.data[0].id, { required: false });
    for (let i = 0; i < 12; i++) await owner.post('/leads', { firstName: `Zed${String(i).padStart(2, '0')}`, lastName: 'Tester', email: `zed${i}@list.test`, companyName: i % 2 ? 'Odd Co' : 'Even Co', priorityId: prios[i % 3]!.id, customFields: { budget: 1 } });
    const p1 = await owner.get('/leads?q=zed&pageSize=5&sort=name&order=asc');
    expect(p1.body.meta).toMatchObject({ total: 12, pageSize: 5, totalPages: 3 });
    expect(p1.body.data[0].firstName).toBe('Zed00');
    const p3 = await owner.get('/leads?q=zed&pageSize=5&page=3&sort=name&order=asc');
    expect(p3.body.data).toHaveLength(2);
    expect((await owner.get('/leads?q=Odd%20Co')).body.meta.total).toBe(6);
    expect((await owner.get('/leads?q=ZED3@LIST')).body.meta.total).toBe(1);
    expect((await owner.get(`/leads?priorityId=${prios[0]!.id}&q=zed`)).body.meta.total).toBe(4);
    expect((await owner.get('/leads?assignedToId=unassigned&q=zed')).body.meta.total).toBe(12);
    expect((await owner.get('/leads?uncontacted=true&q=zed')).body.meta.total).toBe(12);
    expect((await owner.get('/leads?createdFrom=2999-01-01T00:00:00Z')).body.meta.total).toBe(0);
  });

  it('pipelines: custom stages, ordering rules and protection of stages in use', async () => {
    const pipes = (await owner.get('/pipelines')).body.data;
    expect(pipes).toHaveLength(1);
    const p = pipes[0];
    expect(p.stages.map((s: { name: string }) => s.name)).toEqual(['New', 'Contacted', 'Qualified', 'Meeting Scheduled', 'Proposal Sent', 'Negotiation', 'Won', 'Lost']);
    const added = await owner.post(`/pipelines/${p.id}/stages`, { name: 'Site Visit', probability: 60 });
    expect(added.status).toBe(201);
    const after = (await owner.get('/pipelines')).body.data[0].stages.map((s: { name: string }) => s.name);
    expect(after.indexOf('Site Visit')).toBe(after.indexOf('Won') - 1); // inserted before the outcome stages
    expect((await manager.post(`/pipelines/${p.id}/stages`, { name: 'Nope' })).status).toBe(403);
    // reorder: Won/Lost must stay last
    const ids = (await owner.get('/pipelines')).body.data[0].stages.map((s: { id: string }) => s.id) as string[];
    const bad = [ids[ids.length - 2]!, ...ids.slice(0, ids.length - 2), ids[ids.length - 1]!];
    expect((await owner.post(`/pipelines/${p.id}/stages/reorder`, { stageIds: bad })).status).toBe(400);
    const good = [ids[1]!, ids[0]!, ...ids.slice(2)];
    expect((await owner.post(`/pipelines/${p.id}/stages/reorder`, { stageIds: good })).status).toBe(200);
    expect((await owner.get('/pipelines')).body.data[0].stages[0].name).toBe('Contacted');
    // stage with opportunities cannot be deleted
    const lead = (await owner.post('/leads', { firstName: 'Opp', email: 'opp@stage.test', customFields: { budget: 1 } })).body.data.id;
    const opp = await owner.post('/opportunities', { leadId: lead, name: 'Deal', value: 10, stageId: ids[2] });
    expect(opp.status).toBe(201);
    expect((await owner.del(`/stages/${ids[2]}`)).status).toBe(409);
    expect((await owner.del(`/stages/${added.body.data.id}`)).status).toBe(200);
    // outcome stages can't be created as the starting stage
    const wonStage = (await owner.get('/pipelines')).body.data[0].stages.find((s: { kind: string }) => s.kind === 'WON');
    expect((await owner.post('/opportunities', { leadId: lead, name: 'Direct win', value: 1, stageId: wonStage.id })).status).toBe(400);
    // can't archive the default pipeline; second pipeline is a Professional feature
    expect((await owner.del(`/pipelines/${p.id}`)).status).toBe(409);
    const second = await owner.post('/pipelines', { name: 'Partners' });
    expect(second.status).toBe(201);
    expect((await owner.patch(`/pipelines/${second.body.data.id}`, { isDefault: true })).status).toBe(200);
    expect((await owner.get('/pipelines')).body.data.find((x: { isDefault: boolean }) => x.isDefault).name).toBe('Partners');
    // opportunities can move across pipelines and keep history
    const newStage = (await owner.get('/pipelines')).body.data.find((x: { name: string }) => x.name === 'Partners').stages[1];
    expect((await owner.post(`/opportunities/${opp.body.data.id}/move`, { stageId: newStage.id })).status).toBe(200);
    expect((await owner.get(`/opportunities/${opp.body.data.id}`)).body.data.history.length).toBe(2);
  });

  it('roles: custom role with limited permissions is enforced and members can be re-roled', async () => {
    const role = (await owner.post('/roles', { name: 'Lead Intake', permissions: ['leads.create'] })).body.data;
    const roleMember = await addMember(owner, 'SALES_AGENT');
    const members = (await owner.get('/members')).body.data as Array<{ id: string; userId: string }>;
    const m = members.find((x) => x.userId === roleMember.userId)!;
    expect((await owner.patch(`/members/${m.id}`, { roleId: role.id })).status).toBe(200);
    expect((await roleMember.post('/leads', { firstName: 'Intake', email: 'intake@x.com', customFields: { budget: 1 } })).status).toBe(201);
    expect((await roleMember.post('/tasks', { title: 'x' })).status).toBe(403);
    expect((await owner.del(`/roles/${role.id}`)).status).toBe(409); // in use
    const ownerRole = (await owner.get('/roles')).body.data.find((r: { systemKey: string }) => r.systemKey === 'OWNER');
    expect((await owner.patch(`/roles/${ownerRole.id}`, { permissions: [] })).status).toBe(403);
  });

  it('company settings, onboarding and audit trail', async () => {
    const upd = await owner.patch('/organizations/current', { name: 'Config Co Ltd', timezone: 'Asia/Karachi', currency: 'PKR', dateFormat: 'dd/MM/yyyy', website: 'https://config.test' });
    expect(upd.status).toBe(200);
    const cur = (await owner.get('/organizations/current')).body.data.organization;
    expect(cur).toMatchObject({ name: 'Config Co Ltd', timezone: 'Asia/Karachi', currency: 'PKR' });
    expect((await owner.post('/organizations/current/onboarding', { complete: true })).status).toBe(200);
    expect((await owner.patch('/organizations/current', { currency: 'toolong' })).status).toBe(400);
    const log = (await owner.get('/audit-logs')).body.data.map((l: { action: string }) => l.action);
    expect(log).toEqual(expect.arrayContaining(['workspace.updated', 'workspace.onboarded', 'role.created', 'custom_field.created']));
  });

  it('account security: profile, password change, session listing and revocation', async () => {
    const u = await signUp('Secure User');
    expect((await u.agent.patch('/api/auth/profile').send({ name: 'Secure Renamed', phone: '123456' })).status).toBe(200);
    expect((await u.agent.get('/api/auth/me')).body.data.user.name).toBe('Secure Renamed');
    const wrong = await u.agent.post('/api/auth/change-password').send({ currentPassword: 'nope-nope1', newPassword: 'NewPassw0rd!' });
    expect(wrong.status).toBe(400);
    const second = (await import('./helpers')).request.agent((await import('./helpers')).app);
    expect((await second.post('/api/auth/login').send({ email: u.email, password: (await import('./helpers')).PASSWORD })).status).toBe(200);
    const sessions = (await u.agent.get('/api/auth/sessions')).body.data;
    expect(sessions).toHaveLength(2);
    expect((await u.agent.post('/api/auth/change-password').send({ currentPassword: (await import('./helpers')).PASSWORD, newPassword: 'NewPassw0rd!' })).status).toBe(200);
    expect((await second.get('/api/auth/me')).status).toBe(401); // other devices signed out
    expect((await u.agent.get('/api/auth/me')).status).toBe(200);
  });
});
