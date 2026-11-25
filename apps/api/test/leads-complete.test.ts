import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, boot, createWorkspace, ownerPrisma, signUp, uniq, type Actor } from './helpers';

const csv = (lines: string[]) => Buffer.from(lines.join('\n'));
const importCsv = (a: Actor, lines: string[], q = '') => a.agent.post(`/api/leads/import${q}`).set('X-Org-Id', a.orgId!).attach('file', csv(lines), 'leads.csv');
beforeAll(async () => { await boot(); });

describe('saved views are stored on the server, scoped and tenant-safe', () => {
  let owner: Actor, manager: Actor, agent: Actor, other: Actor;
  beforeAll(async () => {
    owner = await createWorkspace(await signUp('Views Owner'), `Views ${uniq()}`);
    manager = await addMember(owner, 'MANAGER'); agent = await addMember(owner, 'SALES_AGENT');
    other = await createWorkspace(await signUp('Views Other'), `ViewsB ${uniq()}`);
  });
  it('personal views are private, shared views need the assign permission, and only known filter keys are kept', async () => {
    const mine = await manager.post('/lead-views', { name: 'Hot & new', query: 'status=NEW&priorityId=x&evil=1&page=9&sort=lastActivityAt&assignedToId=' + 'a'.repeat(300) });
    expect(mine.status).toBe(201);
    expect(mine.body.data.query).toBe('status=NEW&priorityId=x&sort=lastActivityAt');   // page / unknown / oversize values are dropped
    expect((await agent.post('/lead-views', { name: 'Team view', query: 'status=NEW', isShared: true })).status).toBe(403);
    const shared = await manager.post('/lead-views', { name: 'Team: uncontacted', query: 'uncontacted=true', isShared: true });
    expect(shared.status).toBe(201);
    const agentList = (await agent.get('/lead-views')).body.data as Array<{ name: string; mine: boolean; owner: string }>;
    expect(agentList.map((v) => v.name)).toEqual(['Team: uncontacted']);              // sees the shared one, not the manager's personal one
    expect(agentList[0]!.mine).toBe(false);
    expect((await manager.get('/lead-views')).body.data.map((v: { name: string }) => v.name).sort()).toEqual(['Hot & new', 'Team: uncontacted']);
    // nobody else's workspace sees them
    expect((await other.get('/lead-views')).body.data).toHaveLength(0);
    expect((await other.del(`/lead-views/${shared.body.data.id}`)).status).toBe(404);
    // ownership: the agent cannot edit or delete the manager's shared view; an unrelated personal view is invisible (404, not 403)
    expect((await agent.patch(`/lead-views/${shared.body.data.id}`, { name: 'hijack' })).status).toBe(403);
    expect((await agent.del(`/lead-views/${shared.body.data.id}`)).status).toBe(403);
    expect((await agent.del(`/lead-views/${mine.body.data.id}`)).status).toBe(404);
    expect((await owner.del(`/lead-views/${shared.body.data.id}`)).status).toBe(200);   // workspace admins may clean up shared views
  });
  it('saving under an existing name replaces your own view; the per-user limit is enforced', async () => {
    const a = await agent.post('/lead-views', { name: 'Mine', query: 'status=NEW' });
    const b = await agent.post('/lead-views', { name: 'mine', query: 'status=LOST' });
    expect(b.body.data.id).toBe(a.body.data.id); expect(b.body.data.query).toBe('status=LOST');
    expect((await agent.get('/lead-views')).body.data.filter((v: { name: string }) => v.name.toLowerCase() === 'mine')).toHaveLength(1);
    for (let i = 0; i < 49; i++) expect((await agent.post('/lead-views', { name: `v${i}`, query: '' })).status).toBe(201);
    expect((await agent.post('/lead-views', { name: 'one too many', query: '' })).status).toBe(409);
  });
});

describe('custom fields: every type validates strictly and persists', () => {
  let owner: Actor;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    owner = await createWorkspace(await signUp('CF Owner'), `CF ${uniq()}`);
    for (const f of [
      { label: 'Budget', type: 'NUMBER' }, { label: 'Renewal date', type: 'DATE' }, { label: 'Tier', type: 'SELECT', options: ['Gold', 'Silver'], required: false },
      { label: 'Decision maker', type: 'BOOLEAN' }, { label: 'Notes', type: 'TEXT' }, { label: 'Region', type: 'SELECT', options: ['EMEA', 'APAC'], required: true },
    ]) { const r = await owner.post('/custom-fields', f); expect(r.status, JSON.stringify(r.body)).toBe(201); ids[f.label] = r.body.data.id; }
  });
  const lead = (custom: Record<string, unknown>) => owner.post('/leads', { firstName: 'CF', email: `cf-${uniq()}@x.com`, customFields: { region: 'EMEA', ...custom } });
  it('rejects wrong types, impossible dates, unknown options and over-long text instead of truncating or coercing', async () => {
    for (const [custom, field] of [
      [{ budget: 'lots' }, 'budget'], [{ budget: 'Infinity' }, 'budget'], [{ renewal_date: '2026-02-30' }, 'renewal_date'], [{ renewal_date: 'next week' }, 'renewal_date'],
      [{ tier: 'Bronze' }, 'tier'], [{ decision_maker: 'maybe' }, 'decision_maker'], [{ notes: 'x'.repeat(501) }, 'notes'],
    ] as Array<[Record<string, unknown>, string]>) {
      const r = await lead(custom);
      expect(r.status, JSON.stringify(custom)).toBe(400);
      expect(Object.keys(r.body.error.details.fields)).toContain(`customFields.${field}`);
    }
    const missing = await owner.post('/leads', { firstName: 'NoRegion', email: `nr-${uniq()}@x.com` });
    expect(missing.status).toBe(400); expect(Object.keys(missing.body.error.details.fields)).toContain('customFields.region');   // required field
  });
  it('accepts and normalises valid values, persists them, returns them and exports them', async () => {
    const r = await lead({ budget: '12,500.50', renewal_date: '2027-03-01T10:00:00Z', tier: 'gold', decision_maker: 'Yes', notes: ' hello ' });
    expect(r.status).toBe(201);
    expect(r.body.data.customFields).toMatchObject({ budget: 12500.5, renewal_date: '2027-03-01', tier: 'Gold', decision_maker: true, notes: 'hello', region: 'EMEA' });
    const read = await owner.get(`/leads/${r.body.data.id}`);
    expect(read.body.data.customFields.tier).toBe('Gold');
    const upd = await owner.patch(`/leads/${r.body.data.id}`, { customFields: { budget: 99, region: 'APAC' } });
    expect(upd.status).toBe(200);
    expect(upd.body.data.customFields).toMatchObject({ budget: 99, region: 'APAC' });
    const exp = await owner.get('/leads/export?format=csv');
    expect(exp.status).toBe(200);
    const header = String(exp.text).split('\n')[0]!;
    for (const label of ['Budget', 'Renewal date', 'Tier', 'Decision maker', 'Region']) expect(header).toContain(label);
    expect(String(exp.text)).toMatch(/APAC/);
  });
  it('protects data when a field changes: type and key are locked, options in use cannot be removed, new options can be added', async () => {
    expect((await owner.patch(`/custom-fields/${ids['Tier']}`, { type: 'TEXT' })).body.error.code).toBe('TYPE_LOCKED');
    expect((await owner.patch(`/custom-fields/${ids['Tier']}`, { key: 'other' })).body.error.code).toBe('KEY_LOCKED');
    await lead({ tier: 'Silver' });
    const removeUsed = await owner.patch(`/custom-fields/${ids['Tier']}`, { options: ['Gold'] });
    expect(removeUsed.status).toBe(409); expect(removeUsed.body.error.code).toBe('OPTION_IN_USE');
    expect((await owner.patch(`/custom-fields/${ids['Tier']}`, { options: [] })).status).toBe(400);
    expect((await owner.patch(`/custom-fields/${ids['Tier']}`, { options: ['Gold', 'Silver', 'Platinum'] })).status).toBe(200);
    expect((await lead({ tier: 'Platinum' })).status).toBe(201);
    expect((await owner.patch(`/custom-fields/${ids['Budget']}`, { options: ['x'] })).status).toBe(400);   // only dropdowns have options
  });
  it('import maps custom-field columns by label and rejects invalid values per row without dropping them silently', async () => {
    const lines = ['First Name,Email,Budget,Tier,Region,Renewal date', `Ok,ok-${uniq()}@x.com,1000,Gold,EMEA,2027-01-31`, `BadNum,bn-${uniq()}@x.com,lots,Gold,EMEA,`, `BadTier,bt-${uniq()}@x.com,5,Bronze,EMEA,`, `NoRegion,nr2-${uniq()}@x.com,5,Gold,,`];
    const r = await importCsv(owner, lines);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ total: 4, created: 1, failed: 3 });
    expect(r.body.data.errors.map((e: { row: number }) => e.row)).toEqual([3, 4, 5]);
    expect(r.body.data.errors[0].message).toMatch(/Budget must be a number/);
    expect(r.body.data.total).toBe(r.body.data.created + r.body.data.failed + r.body.data.skippedDuplicates);   // every row is accounted for
    const created = (await owner.get('/leads?q=Ok')).body.data[0];
    expect(created.customFields).toMatchObject({ budget: 1000, tier: 'Gold', region: 'EMEA', renewal_date: '2027-01-31' });
  });
});

describe('tags', () => {
  it('anyone who edits leads can create a tag, but only workspace admins rename or delete shared tags; deleting an used tag deactivates it', async () => {
    const owner = await createWorkspace(await signUp('Tag Owner'), `Tags ${uniq()}`);
    const agent = await addMember(owner, 'SALES_AGENT');
    const t = await agent.post('/tags', { name: 'VIP' });
    expect(t.status).toBe(201);
    expect((await agent.post('/tags', { name: 'vip' })).status).toBe(409);                      // case-insensitive uniqueness
    expect((await agent.patch(`/tags/${t.body.data.id}`, { name: 'Renamed by agent' })).status).toBe(403);
    expect((await agent.del(`/tags/${t.body.data.id}`)).status).toBe(403);
    expect((await owner.patch(`/tags/${t.body.data.id}`, { name: 'VIP customers' })).status).toBe(200);
    const lead = await agent.post('/leads', { firstName: 'Tagged', email: `tg-${uniq()}@x.com`, tagIds: [t.body.data.id] });
    expect(lead.body.data.tags.map((x: { name: string }) => x.name)).toEqual(['VIP customers']);
    const del = await owner.del(`/tags/${t.body.data.id}`);
    expect(del.body.data).toMatchObject({ deleted: false, deactivated: true });
    expect((await agent.get(`/leads/${lead.body.data.id}`)).body.data.tags).toHaveLength(1);     // history on the lead is preserved
    expect((await owner.get('/tags')).body.data.map((x: { name: string }) => x.name)).not.toContain('VIP customers');
    // filtering by tag
    const t2 = await owner.post('/tags', { name: 'Filterable' });
    await owner.post('/leads/bulk', { ids: [lead.body.data.id], action: 'tag', tagId: t2.body.data.id });
    expect((await owner.get(`/leads?tagId=${t2.body.data.id}`)).body.meta.total).toBe(1);
  });
});

describe('import and export: limits, boundaries and honesty', () => {
  let owner: Actor, manager: Actor, agent: Actor, rival: Actor;
  beforeAll(async () => {
    owner = await createWorkspace(await signUp('IO Owner'), `IO ${uniq()}`);
    manager = await addMember(owner, 'MANAGER'); agent = await addMember(owner, 'SALES_AGENT');
    rival = await createWorkspace(await signUp('IO Rival'), `IOB ${uniq()}`);
  });
  it('imports a few thousand rows in one go, accounts for every row, and refuses files above the cap', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => `Lead${i},Bulk,bulk${i}-${uniq()}@x.com`);
    const bad = ['NoName,,', ',Nameless,nameless@x.com'];
    const r = await importCsv(owner, ['First Name,Last Name,Email', ...rows, ...bad]);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ total: 3002, created: 3000, failed: 2 });
    expect((await owner.get('/leads?pageSize=1')).body.meta.total).toBe(3000);
    expect(await ownerPrisma.activity.count({ where: { organizationId: owner.orgId!, type: 'LEAD_CREATED' } })).toBe(3000);
    expect(r.body.data.notes.join(' ')).toMatch(/first 200/);
    const huge = await importCsv(owner, ['First Name,Email', ...Array.from({ length: 5001 }, (_, i) => `H${i},h${i}@x.com`)]);
    expect(huge.status).toBe(400); expect(huge.body.error.code).toBe('TOO_MANY_ROWS');
  }, 120_000);
  it('never merges or overwrites on import: duplicates are skipped (or explicitly imported), within the file and against existing leads', async () => {
    const email = `dup-${uniq()}@x.com`;
    await owner.post('/leads', { firstName: 'Existing', email, phone: '+1 202 555 0143' });
    const r = await importCsv(owner, ['First Name,Email,Phone', `Same,${email.toUpperCase()},`, 'Phone,,(202) 555-0143', `New,new-${uniq()}@x.com,`, `NewAgain,${'new-'}x@x.com,`, `NewAgain2,${'new-'}x@x.com,`]);
    expect(r.body.data).toMatchObject({ created: 2, skippedDuplicates: 3, failed: 0 });
    expect((await owner.get(`/leads?q=${encodeURIComponent('Existing')}`)).body.data[0].firstName).toBe('Existing');
    const forced = await importCsv(owner, ['First Name,Email', `Forced,${email}`], '?duplicates=import');
    expect(forced.body.data.created).toBe(1);
  });
  it('tenant and permission boundaries: assignees of other workspaces are refused, agents cannot import or export, managers can', async () => {
    const r = await importCsv(owner, ['First Name,Email,Assigned To', `Cross,cross-${uniq()}@x.com,${rival.email}`], '?dryRun=true');
    expect(r.body.data.errors[0].message).toMatch(/not an active member/);
    expect((await agent.agent.post('/api/leads/import').set('X-Org-Id', agent.orgId!).attach('file', csv(['First Name,Email', 'A,a@x.com']), 'l.csv')).status).toBe(403);
    expect((await agent.get('/leads/export?format=csv')).status).toBe(403);
    expect((await manager.get('/leads/export?format=xlsx')).status).toBe(200);
    expect((await rival.get('/leads?pageSize=1')).body.meta.total).toBe(0);               // nothing leaked into the other workspace
    const rivalExport = await rival.get('/leads/export?format=csv');
    expect(String(rivalExport.text)).not.toContain('Bulk');
  });
  it('neutralises spreadsheet formulas in exported cells and in imported text', async () => {
    const r = await importCsv(owner, ['First Name,Email,Company', `=cmd|' /C calc'!A0,f-${uniq()}@x.com,+SUM(1+1)`]);
    expect(r.body.data.created).toBe(1);
    const out = String((await owner.get('/leads/export?format=csv&q=cmd')).text);
    expect(out).not.toMatch(/(^|,)"?=cmd/); expect(out).not.toMatch(/,"?\+SUM/);
  });
});

describe('merge and bulk actions respect ownership and tenant boundaries', () => {
  it('merging cannot cross workspaces or touch leads the caller cannot see; bulk actions are all-or-nothing', async () => {
    const owner = await createWorkspace(await signUp('M Owner'), `Merge ${uniq()}`);
    const agent = await addMember(owner, 'SALES_AGENT');
    const rival = await createWorkspace(await signUp('M Rival'), `MergeB ${uniq()}`);
    const a = await owner.post('/leads', { firstName: 'A', email: `a-${uniq()}@x.com`, assignedToId: owner.userId });
    const b = await owner.post('/leads', { firstName: 'B', email: `b-${uniq()}@x.com`, assignedToId: owner.userId });
    const foreign = await rival.post('/leads', { firstName: 'Foreign', email: `f-${uniq()}@x.com` });
    expect((await owner.post('/leads/merge', { sourceId: foreign.body.data.id, targetId: a.body.data.id })).status).toBe(404);
    expect((await owner.post('/leads/merge', { sourceId: a.body.data.id, targetId: foreign.body.data.id })).status).toBe(404);
    expect((await agent.post('/leads/merge', { sourceId: a.body.data.id, targetId: b.body.data.id })).status).toBeGreaterThanOrEqual(403);   // agent cannot see the owner's leads
    expect((await owner.post('/leads/merge', { sourceId: a.body.data.id, targetId: a.body.data.id })).status).toBe(400);
    // bulk: one foreign id poisons the whole request, nothing changes
    const bulk = await owner.post('/leads/bulk', { ids: [a.body.data.id, foreign.body.data.id], action: 'status', status: 'QUALIFIED' });
    expect(bulk.status).toBeGreaterThanOrEqual(400);
    expect((await owner.get(`/leads/${a.body.data.id}`)).body.data.status).toBe('NEW');
    expect((await owner.post('/leads/bulk', { ids: Array.from({ length: 501 }, () => a.body.data.id), action: 'archive' })).status).toBe(400);
    // an agent cannot bulk-assign leads to someone else
    const own = await agent.post('/leads', { firstName: 'Mine', email: `m-${uniq()}@x.com` });
    expect((await agent.post('/leads/bulk', { ids: [own.body.data.id], action: 'assign', assignedToId: owner.userId })).status).toBe(403);
  });
});
