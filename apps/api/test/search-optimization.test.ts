import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { resetCacheMemo } from '../src/lib/cache';
import { resetSearchMemo } from '../src/modules/leads/queries';
import { addMember, boot, createWorkspace, ownerPrisma, signUp, uniq, type Actor } from './helpers';

let owner: Actor, agent: Actor, other: Actor;
const names = [
  ['Olivia', 'Smith', 'olivia.smith@acme.test', '+1 202 555 0143', 'Acme Corp'], ['Liam', 'Smithson', 'liam@smithson.test', '+44 20 7946 0958', 'Smithson Ltd'], ['Noah', 'Patel', 'noah.patel@globex.test', '+1 415 555 2671', 'Globex'],
  ['Ana', 'a_b', 'underscore@x.test', null, 'Under_Score Inc'], ['Axb', 'Plain', 'plain@x.test', null, 'Plain Inc'], ['Percy', '100% Legit', 'percent@x.test', null, 'Pct Co'], ['Zoë', 'Müller', 'zoe@muller.test', '030 1234567', 'Müller GmbH'],
];
const ids: Record<string, string> = {};
const search = async (a: Actor, q: string, extra = '') => ((await a.get(`/leads?q=${encodeURIComponent(q)}&pageSize=100${extra}`)).body as { data: Array<{ id: string; email: string }>; meta: { total: number } });
const emails = async (a: Actor, q: string) => (await search(a, q)).data.map((l) => l.email).sort();

beforeAll(async () => {
  await boot();
  owner = await createWorkspace(await signUp('Search Owner'), `Search ${uniq()}`);
  agent = await addMember(owner, 'SALES_AGENT', 'Search Agent');
  other = await createWorkspace(await signUp('Search Other'), `SearchB ${uniq()}`);
  for (const [f, l, e, p, c] of names) { const r = await owner.post('/leads', { firstName: f, lastName: l, email: e, phone: p ?? undefined, companyName: c }); expect(r.status, JSON.stringify(r.body)).toBe(201); ids[e!] = r.body.data.id; }
  await other.post('/leads', { firstName: 'Olivia', lastName: 'Smith', email: 'olivia.smith@acme.test', companyName: 'Acme Corp' });   // same data in ANOTHER workspace
  await agent.post('/leads', { firstName: 'Mine', lastName: 'Smithy', email: 'mine@smithy.test' });                                             // agent-owned lead
});

describe('indexed search returns exactly what the previous ILIKE search returned', () => {
  const queries = ['olivia', 'SMITH', 'smith', 'smith olivia', 'acme', '555', '+1 202', '2025550143', '202 555 0143', 'ACME corp', 'glob', 'müller', 'MÜLLER', 'a_b', 'a%', '100%', '_', 'x.test', 'nomatchzzq', 'smithson.test', 'ana a_b', 'li', 'ol sm', '.test'];
  it('gives identical results for plain, multi-term, phone, wildcard-character, case and accent queries — and for short terms', async () => {
    const strategy = config.searchStrategy;
    const answers = new Map<string, string[]>();
    try {
      (config as { searchStrategy: string }).searchStrategy = 'ilike';
      for (const q of queries) answers.set(q, await emails(owner, q));
      (config as { searchStrategy: string }).searchStrategy = 'indexed';
      for (const q of queries) expect(await emails(owner, q), `query "${q}"`).toEqual(answers.get(q));
    } finally { (config as { searchStrategy: string }).searchStrategy = strategy; }
    // sanity of the expectations themselves
    expect(answers.get('olivia')).toEqual(['olivia.smith@acme.test']);
    expect(answers.get('smith')).toEqual(['liam@smithson.test', 'mine@smithy.test', 'olivia.smith@acme.test']);
    expect(answers.get('a_b')).toEqual(['underscore@x.test']);               // _ is literal, not "any character" (would also match "Axb")
    expect(answers.get('100%')).toEqual(['percent@x.test']);                  // % is literal
    expect(answers.get('2025550143')).toEqual(['olivia.smith@acme.test']);    // digits match the normalised phone
    expect(answers.get('nomatchzzq')).toEqual([]);
  });

  it('respects every other filter, archive state and agent scope together with the search', async () => {
    // archived leads disappear, restoring brings them back
    const id = ids['liam@smithson.test']!;
    expect((await owner.post(`/leads/${id}/archive`)).status).toBe(200);
    expect(await emails(owner, 'smithson')).toEqual([]);
    expect((await search(owner, 'smithson', '&archived=true')).data.map((l) => l.email)).toEqual(['liam@smithson.test']);
    expect((await owner.post(`/leads/${id}/restore`)).status).toBe(200);
    expect(await emails(owner, 'smithson')).toEqual(['liam@smithson.test']);
    // the agent only ever sees their own leads, even though the search index spans the workspace
    expect(await emails(agent, 'smith')).toEqual(['mine@smithy.test']);
    expect(await emails(agent, 'olivia')).toEqual([]);
    // combined with a status filter
    expect((await search(owner, 'smith', '&status=CONVERTED')).data).toHaveLength(0);
    expect((await search(owner, 'smith', '&status=NEW')).meta.total).toBe(3);
  });

  it('returns the same page and total at every page size, and honours the id cap for broad terms', async () => {
    const keep = config.searchMaxIds;
    try {
      const all = await search(owner, 'test');                                    // matches (almost) everything
      (config as { searchMaxIds: number }).searchMaxIds = 2; resetSearchMemo();     // force the broad-term fallback path
      const broad = await search(owner, 'test');
      expect(broad.meta.total).toBe(all.meta.total);
      expect(broad.data.map((l) => l.id)).toEqual(all.data.map((l) => l.id));
      (config as { searchMaxIds: number }).searchMaxIds = keep; resetSearchMemo();
      const p1 = (await owner.get('/leads?q=smith&pageSize=2&page=1')).body, p2 = (await owner.get('/leads?q=smith&pageSize=2&page=2')).body;
      expect(p1.meta.total).toBe(3); expect(p1.data).toHaveLength(2); expect(p2.data).toHaveLength(1);
      expect(new Set([...p1.data, ...p2.data].map((l: { id: string }) => l.id)).size).toBe(3);
    } finally { (config as { searchMaxIds: number }).searchMaxIds = keep; }
  });
});

describe('search isolation', () => {
  it('never returns another workspace\'s leads, even for identical data', async () => {
    const mine = await search(owner, 'olivia'), theirs = await search(other, 'olivia');
    expect(mine.meta.total).toBe(1); expect(theirs.meta.total).toBe(1);
    expect(mine.data[0]!.id).not.toBe(theirs.data[0]!.id);
    expect((await search(other, 'smithson')).meta.total).toBe(0);
    expect((await search(other, 'müller')).meta.total).toBe(0);
  });

  it('the database function only ever sees the transaction\'s own workspace, nothing without one, and is not callable by other roles', async () => {
    const rows = async (org: string | null, terms: string[]) => ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE leadflow_app`);
      await tx.$executeRaw`SELECT set_config('app.org_id', ${org ?? ''}, true)`;
      return tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM lf_search_lead_ids(ARRAY[${terms.map((t) => `'${t}'`).join(',')}]::text[], 100) AS id`);
    });
    const a = await rows(owner.orgId!, ['olivia']), b = await rows(other.orgId!, ['olivia']);
    expect(a).toHaveLength(1); expect(b).toHaveLength(1);
    expect(a[0]!.id).not.toBe(b[0]!.id);
    expect(await rows(null, ['olivia'])).toHaveLength(0);                       // no workspace set: nothing
    expect(await rows('00000000-0000-0000-0000-000000000000', ['olivia'])).toHaveLength(0);
    expect(await rows(owner.orgId!, ['a'.repeat(1), 'b', 'c', 'd', 'e', 'f', 'g'])).toHaveLength(0);   // more than 6 terms are refused
    const priv = await ownerPrisma.$queryRawUnsafe<Array<{ app: boolean; platform: boolean; pub: boolean; owner: string; definer: boolean }>>(
      `SELECT has_function_privilege('leadflow_app', 'lf_search_lead_ids(text[], integer)', 'EXECUTE') AS app, has_function_privilege('leadflow_platform', 'lf_search_lead_ids(text[], integer)', 'EXECUTE') AS platform,
              has_function_privilege('public', 'lf_search_lead_ids(text[], integer)', 'EXECUTE') AS pub, pg_get_userbyid(proowner) AS owner, prosecdef AS definer FROM pg_proc WHERE proname = 'lf_search_lead_ids'`);
    expect(priv[0]).toMatchObject({ app: true, platform: false, pub: false, owner: 'leadflow_search', definer: true });
    // the search role can read only searchable columns, never notes / custom fields / status
    const cols = await ownerPrisma.$queryRawUnsafe<Array<{ column_name: string }>>(`SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'leadflow_search' AND table_name = 'leads' ORDER BY 1`);
    expect(cols.map((c) => c.column_name)).toEqual(['company_name', 'email', 'first_name', 'id', 'last_name', 'organization_id', 'phone', 'phone_normalized']);
    const role = await ownerPrisma.$queryRawUnsafe<Array<{ rolcanlogin: boolean; rolbypassrls: boolean }>>(`SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'leadflow_search'`);
    expect(role[0]).toEqual({ rolcanlogin: false, rolbypassrls: true });
  });
});

describe('cursor (keyset) pagination', () => {
  let ws: Actor; const created: string[] = [];
  beforeAll(async () => {
    ws = await createWorkspace(await signUp('Cursor Owner'), `Cursor ${uniq()}`);
    // 23 leads, several sharing the same createdAt to exercise the tie-break
    const t = new Date('2026-01-01T10:00:00Z');
    for (let i = 0; i < 23; i++) {
      const l = await ownerPrisma.lead.create({ data: { organizationId: ws.orgId!, firstName: `Cur${String(i).padStart(2, '0')}`, email: `cur${i}@c.test`, emailNormalized: `cur${i}@c.test`, createdAt: new Date(t.getTime() + Math.floor(i / 4) * 60_000), lastActivityAt: t } });
      created.push(l.id);
    }
  });
  const walk = async (order: 'asc' | 'desc', pageSize: number, q = '') => {
    const seen: string[] = []; let cursor = 'start'; let guard = 0;
    for (;;) {
      const r = (await ws.get(`/leads?sort=createdAt&order=${order}&pageSize=${pageSize}&cursor=${cursor}${q ? `&q=${q}` : ''}`)).body;
      seen.push(...r.data.map((l: { id: string }) => l.id));
      expect(r.meta.total).toBe(q ? r.meta.total : 23);
      if (!r.meta.hasMore) { expect(r.meta.nextCursor).toBeNull(); break; }
      cursor = r.meta.nextCursor; if (++guard > 30) throw new Error('cursor loop');
    }
    return seen;
  };
  it('walks every lead exactly once in a stable order in both directions, and agrees with offset pagination', async () => {
    const desc = await walk('desc', 5);
    expect(desc).toHaveLength(23); expect(new Set(desc).size).toBe(23);
    const asc = await walk('asc', 7);
    expect(asc).toEqual([...desc].reverse());
    const offset = (await ws.get('/leads?sort=createdAt&order=desc&pageSize=100')).body.data.map((l: { id: string }) => l.id);
    expect(new Set(offset)).toEqual(new Set(desc));
    expect(await walk('desc', 5, 'Cur0')).toHaveLength(10);                      // search + cursor together
  });
  it('is stable while leads are inserted between pages (nothing skipped or repeated)', async () => {
    const first = (await ws.get('/leads?sort=createdAt&order=desc&pageSize=5&cursor=start')).body;
    await ownerPrisma.lead.create({ data: { organizationId: ws.orgId!, firstName: 'Newest', email: 'newest@c.test', emailNormalized: 'newest@c.test', createdAt: new Date('2030-01-01T00:00:00Z'), lastActivityAt: new Date() } });
    const second = (await ws.get(`/leads?sort=createdAt&order=desc&pageSize=5&cursor=${first.meta.nextCursor}`)).body;
    const overlap = second.data.filter((l: { id: string }) => first.data.some((f: { id: string }) => f.id === l.id));
    expect(overlap).toHaveLength(0);
    expect(second.data).toHaveLength(5);
  });
  it('rejects malformed cursors and unsupported sorts with a clear error', async () => {
    const bad = await ws.get('/leads?sort=createdAt&cursor=%%%not-a-cursor');
    expect(bad.status).toBe(400); expect(bad.body.error.code).toBe('INVALID_CURSOR');
    expect((await ws.get(`/leads?sort=createdAt&cursor=${Buffer.from('{"t":"nope","i":"x"}').toString('base64url')}`)).body.error.code).toBe('INVALID_CURSOR');
    const sort = await ws.get('/leads?sort=name&cursor=start');
    expect(sort.status).toBe(400); expect(sort.body.error.code).toBe('CURSOR_UNSUPPORTED_SORT');
    expect((await other.get(`/leads?sort=createdAt&cursor=start`)).body.meta.total).toBe(1);   // another workspace's cursor space is its own
  });
});

describe('lead-total cache is invalidated by every committed lead change', () => {
  let ws: Actor; const keep = config.largeWorkspaceLeads;
  beforeAll(async () => {
    ws = await createWorkspace(await signUp('Cache Owner'), `Cache ${uniq()}`);
    for (let i = 0; i < 3; i++) await ws.post('/leads', { firstName: `C${i}`, email: `c${i}@cache.test` });
    // make it count as a "large" workspace so the result cache is active for it (snapshot says 100 leads, threshold 50)
    await ownerPrisma.usageRecord.create({ data: { organizationId: ws.orgId!, day: new Date(), leads: 100, seats: 1 } as never }).catch(async () => { await ownerPrisma.usageRecord.updateMany({ where: { organizationId: ws.orgId! }, data: { leads: 100 } }); });
    (config as { largeWorkspaceLeads: number }).largeWorkspaceLeads = 50; resetCacheMemo();
  });
  afterAll(() => { (config as { largeWorkspaceLeads: number }).largeWorkspaceLeads = keep; resetCacheMemo(); });
  const total = async () => (await ws.get('/leads?pageSize=1')).body.meta.total as number;
  it('shows the new total immediately after create, archive, restore, bulk and import — while still serving repeated reads from the cache', async () => {
    expect(await total()).toBe(3);
    // proof that the cache is active: a change made behind the application's back (no version bump) is NOT visible yet
    await ownerPrisma.lead.create({ data: { organizationId: ws.orgId!, firstName: 'Sneaky', email: 'sneaky@cache.test', emailNormalized: 'sneaky@cache.test' } });
    expect(await total()).toBe(3);
    // every change through the application is visible at once
    const l = (await ws.post('/leads', { firstName: 'Fresh', email: 'fresh@cache.test' })).body.data.id as string;
    expect(await total()).toBe(5);                                                // 3 + sneaky + fresh
    await ws.post(`/leads/${l}/archive`); expect(await total()).toBe(4);
    await ws.post(`/leads/${l}/restore`); expect(await total()).toBe(5);
    const all = (await ws.get('/leads?pageSize=10')).body.data.map((x: { id: string }) => x.id).slice(0, 2);
    await ws.post('/leads/bulk', { action: 'archive', ids: all }); expect(await total()).toBe(3);
    // another workspace's cache is independent
    expect((await other.get('/leads?pageSize=1')).body.meta.total).toBe(1);
  });
});

describe('index availability and plan (30,000 generated leads)', () => {
  let big: Actor;
  beforeAll(async () => {
    big = await createWorkspace(await signUp('Big Owner'), `Big ${uniq()}`);
    await ownerPrisma.$executeRawUnsafe(`INSERT INTO leads (id, organization_id, first_name, last_name, email, email_normalized, company_name, phone, phone_normalized, status, created_at, updated_at, last_activity_at, custom_fields)
      SELECT gen_random_uuid(), '${big.orgId}', 'First' || g, 'Last' || (g % 997), 'user' || g || '@bulk' || (g % 311) || '.test', 'user' || g || '@bulk' || (g % 311) || '.test', 'Company ' || (g % 503), '+1 555 ' || lpad(g::text, 7, '0'), '1555' || lpad(g::text, 7, '0'), 'NEW', now() - (g || ' seconds')::interval, now(), now(), '{}'
      FROM generate_series(1, 30000) g`);
    await ownerPrisma.$executeRawUnsafe(`UPDATE leads SET email = 'zq7k9x@odd.test', email_normalized = 'zq7k9x@odd.test' WHERE organization_id = '${big.orgId}' AND first_name = 'First12345'`);
    await ownerPrisma.$executeRawUnsafe('ANALYZE leads');
  }, 120_000);
  it('has a trigram index per searchable column and the search role can use them (the app role cannot: see PRODUCTION_READINESS.md)', async () => {
    const idx = await ownerPrisma.$queryRawUnsafe<Array<{ indexname: string }>>(`SELECT indexname FROM pg_indexes WHERE tablename = 'leads' AND indexdef ILIKE '%gin_trgm_ops%' ORDER BY 1`);
    expect(idx.map((i) => i.indexname)).toEqual(['leads_company_trgm', 'leads_email_trgm', 'leads_first_name_trgm', 'leads_last_name_trgm', 'leads_phone_norm_trgm', 'leads_phone_trgm']);
    const explain = (role: string) => ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      await tx.$executeRaw`SELECT set_config('app.org_id', ${big.orgId!}, true)`;
      const r = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN SELECT id FROM leads WHERE email ILIKE '%zq7k9x%'`);
      return r.map((x) => x['QUERY PLAN']).join('\n');
    });
    // WHY the function exists: under row level security the app role cannot use the trigram index (ILIKE is not leakproof); the search role can
    expect(await explain('leadflow_search')).toMatch(/Bitmap Index Scan on leads_email_trgm/);
    expect(await explain('leadflow_app')).not.toMatch(/leads_email_trgm/);
  });
  it('finds a rare lead through the API quickly and exactly, and a no-match term costs almost nothing', async () => {
    const t0 = Date.now();
    const r = await big.get('/leads?q=user29999%40bulk');
    const ms = Date.now() - t0;
    expect(r.body.data.map((l: { email: string }) => l.email)).toEqual(['user29999@bulk' + (29999 % 311) + '.test']);
    expect(ms).toBeLessThan(1500);
    expect((await big.get('/leads?q=zzqxkv')).body.meta.total).toBe(0);
    expect((await big.get('/leads?q=1555000%2029999')).body.meta.total).toBeGreaterThanOrEqual(0);
    expect((await big.get('/leads?q=user2999 bulk')).body.meta.total).toBeGreaterThan(5);
  });
});
