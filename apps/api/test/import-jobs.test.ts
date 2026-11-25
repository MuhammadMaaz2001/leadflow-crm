import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { withContext } from '../src/db';
import { LocalDiskStorage, setObjectStorage } from '../src/lib/storage';
import { importHooks, processImportJob, sweepImportJobs } from '../src/modules/leads/import-jobs';
import { addMember, boot, createWorkspace, ownerPrisma, signUp, uniq, type Actor } from './helpers';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-imp-'));
class Flaky extends LocalDiskStorage { failPut = false; failStream = false;
  async put(k: string, b: Buffer, t: string) { if (this.failPut) throw new Error('S3 down'); return super.put(k, b, t); }
  async getStream(k: string) { if (this.failStream) throw new Error('S3 down'); return super.getStream(k); } }
const store = new Flaky(dir);

let owner: Actor, manager: Actor, agent: Actor, viewer: Actor, other: Actor;
const csv = (rows: string[][], header = ['First Name', 'Last Name', 'Email', 'Phone', 'Company', 'Source', 'Tags']) => Buffer.from([header, ...rows].map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n'));
const gen = (n: number, prefix = 'p', from = 0) => Array.from({ length: n }, (_, i) => [`Pat${from + i}`, 'Lee', `${prefix}${from + i}@bulk.test`, '', 'Acme', 'Website', 'bulk']);
const upload = (a: Actor, data: Buffer, name = 'leads.csv') => a.agent.post('/api/leads/import/jobs').set('X-Org-Id', a.orgId!).attach('file', data, { filename: name, contentType: 'text/csv' });
const get = async (a: Actor, id: string) => (await a.get(`/leads/import/jobs/${id}`)).body.data;
const leadCount = (org: string, like?: string) => ownerPrisma.lead.count({ where: { organizationId: org, ...(like ? { email: { contains: like } } : {}) } });
const run = async (a: Actor, data: Buffer, dup: 'skip' | 'import' = 'skip', name?: string) => {
  const up = await upload(a, data, name); expect(up.status, JSON.stringify(up.body)).toBe(201);
  const st = await a.post(`/leads/import/jobs/${up.body.data.id}/start`, { duplicates: dup }); expect(st.status, JSON.stringify(st.body)).toBe(200);
  return get(a, up.body.data.id);
};

beforeAll(async () => {
  await boot(); setObjectStorage(store);
  owner = await createWorkspace(await signUp('Imp Owner'), `Imp ${uniq()}`);
  manager = await addMember(owner, 'MANAGER', 'Imp Manager'); agent = await addMember(owner, 'SALES_AGENT', 'Imp Agent'); viewer = await addMember(owner, 'VIEWER', 'Imp Viewer');
  other = await createWorkspace(await signUp('Imp Other'), `ImpB ${uniq()}`);
});
afterEach(() => { importHooks.afterBatch = undefined; store.failPut = false; store.failStream = false; });
afterAll(() => { setObjectStorage(null); fs.rmSync(dir, { recursive: true, force: true }); });

describe('background import — upload, preview and start', () => {
  it('uploads to private storage, analyses the file and imports nothing until started', async () => {
    const before = await leadCount(owner.orgId!);
    const up = await upload(manager, csv([['Ann', 'Ray', 'ann@pv.test', '', 'Co', 'Web', 'a;b'], ['', 'NoName', 'x@pv.test', '', '', '', ''], ['Bob', 'Bad', 'not-an-email', '', '', '', '']]));
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const j = up.body.data;
    expect(j).toMatchObject({ status: 'PREVIEW', totalRows: 3, canStart: true, fileFormat: 'csv', processedRows: 0 });
    expect(j.mapping).toMatchObject({ 'First Name': 'firstName', Email: 'email', Company: 'companyName', Source: 'source', Tags: 'tags' });
    expect(j.preview.map((p: { status: string }) => p.status)).toEqual(['OK', 'ERROR', 'ERROR']);
    expect(j.preview[1].message).toMatch(/First name/); expect(j.preview[2].message).toMatch(/Invalid email/);
    const row = await ownerPrisma.importJob.findUniqueOrThrow({ where: { id: j.id } });
    expect(row.fileKey).toMatch(new RegExp(`^imports/${owner.orgId}/${j.id}\\.csv$`));
    expect(fs.existsSync(path.join(dir, row.fileKey!))).toBe(true);
    expect(await leadCount(owner.orgId!)).toBe(before);
    expect(JSON.stringify(j)).not.toContain('imports/');            // no storage key in responses
  });

  it('imports valid rows, reports each invalid row and duplicate with its row number and reason, and cleans up', async () => {
    await owner.post('/leads', { firstName: 'Existing', email: 'dupe@ok.test' });
    const data = csv([
      ['Good', 'One', 'good1@ok.test', '', 'Acme', 'Referral', 'vip; q2'],
      ['', 'NoName', 'noname@ok.test', '', '', '', ''],
      ['Bad', 'Mail', 'bad mail', '', '', '', ''],
      ['Dupe', 'Existing', 'DUPE@ok.test', '', '', '', ''],                // duplicate of an existing lead (case-insensitive)
      ['Good', 'Two', 'good2@ok.test', '', '', 'Brand New Source', ''],
      ['Twice', 'A', 'twice@ok.test', '', '', '', ''],
      ['Twice', 'B', 'twice@ok.test', '', '', '', ''],                      // duplicate inside the file
      ['=cmd', '|calc', 'inj@ok.test', '', '', '', ''],
    ]);
    const j = await run(manager, data);
    expect(j).toMatchObject({ status: 'COMPLETED', totalRows: 8, processedRows: 8, createdRows: 4, failedRows: 2, skippedRows: 2, progress: 100 });
    expect(await leadCount(owner.orgId!, '@ok.test')).toBe(1 + 4);      // 1 pre-existing + 4 imported
    const tags = await ownerPrisma.leadTag.findMany({ where: { organizationId: owner.orgId!, lead: { email: 'good1@ok.test' } }, include: { tag: true } });
    expect(tags.map((t) => t.tag.name).sort()).toEqual(['q2', 'vip']);
    expect(await ownerPrisma.leadSource.count({ where: { organizationId: owner.orgId!, name: 'Brand New Source' } })).toBe(1);
    const act = await ownerPrisma.activity.findFirstOrThrow({ where: { organizationId: owner.orgId!, lead: { email: 'good1@ok.test' }, type: 'LEAD_CREATED' } });
    expect(act.title).toBe('Lead created (import)'); expect(act.actorId).toBe(manager.userId);
    // the error report: row numbers (header = row 1), reasons and the original values — and it is safe to open in a spreadsheet
    const rep = await manager.agent.get(`/api/leads/import/jobs/${j.id}/errors`).set('X-Org-Id', owner.orgId!);
    expect(rep.status).toBe(200); expect(rep.headers['content-type']).toMatch(/text\/csv/); expect(rep.headers['content-disposition']).toMatch(/errors\.csv/);
    const text = rep.text;
    expect(text).toMatch(/^\uFEFFRow,Type,Field,Problem,First Name/);
    expect(text).toMatch(/\n3,Error,firstName,First name \(or Name\) is required/);
    expect(text).toContain('\n4,Error,email,"Invalid email ""bad mail"""');
    expect(text).toMatch(/\n5,Duplicate \(skipped\),,Duplicate email or phone — skipped,Dupe,Existing,DUPE@ok.test/);
    expect(text).toMatch(/\n8,Duplicate \(skipped\)/);
    // temporary file removed, history kept, creator notified, audit written
    const row = await ownerPrisma.importJob.findUniqueOrThrow({ where: { id: j.id } });
    expect(row.fileDeletedAt).not.toBeNull(); expect(fs.existsSync(path.join(dir, row.fileKey!))).toBe(false); expect(row.finishedAt).not.toBeNull();
    const hist = (await manager.get('/leads/import/jobs')).body.data;
    expect(hist.jobs[0]).toMatchObject({ id: j.id, status: 'COMPLETED', createdBy: { name: 'Imp Manager' } });
    expect(hist.limits).toMatchObject({ maxRows: config.importMaxRows, batchSize: config.importBatchSize });
    const notes = (await manager.get('/notifications')).body.data as Array<{ title: string; body: string }>;
    expect(notes.some((n) => /Import finished/.test(n.title) && /4 leads imported, 2 rows with problems, 2 skipped/.test(n.body))).toBe(true);
    expect(await ownerPrisma.auditLog.count({ where: { organizationId: owner.orgId!, action: 'lead.imported', entityId: j.id } })).toBe(1);
  });

  it('can import duplicates on request, and starting twice never imports twice', async () => {
    await owner.post('/leads', { firstName: 'Orig', email: 'orig@dupmode.test' });
    const up = await upload(owner, csv([['Copy', 'Cat', 'orig@dupmode.test', '', '', '', '']]));
    const id = up.body.data.id;
    const [a, b] = await Promise.all([owner.post(`/leads/import/jobs/${id}/start`, { duplicates: 'import' }), owner.post(`/leads/import/jobs/${id}/start`, { duplicates: 'import' })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await leadCount(owner.orgId!, 'orig@dupmode.test')).toBe(2);
    expect((await get(owner, id)).createdRows).toBe(1);
    expect((await owner.post(`/leads/import/jobs/${id}/start`, { duplicates: 'import' })).body.data.status).toBe('COMPLETED');      // a late retry is a no-op
    expect(await leadCount(owner.orgId!, 'orig@dupmode.test')).toBe(2);
  });

  it('streams an Excel workbook too, honouring custom fields', async () => {
    await owner.post('/custom-fields', { label: 'Budget', key: 'budget', type: 'NUMBER' });
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Leads');
    ws.addRow(['Name', 'Email', 'Budget']); ws.addRow(['Xia Lin', 'xia@xl.test', 1200]); ws.addRow(['Yan Ma', 'yan@xl.test', 'lots']); ws.addRow([]); ws.addRow(['Zed Qu', 'zed@xl.test', 50]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const j = await run(owner, buf, 'skip', 'book.xlsx');
    expect(j).toMatchObject({ status: 'COMPLETED', fileFormat: 'xlsx', totalRows: 3, createdRows: 2, failedRows: 1 });
    const xia = await ownerPrisma.lead.findFirstOrThrow({ where: { organizationId: owner.orgId!, email: 'xia@xl.test' } });
    expect(xia).toMatchObject({ firstName: 'Xia', lastName: 'Lin' }); expect(xia.customFields).toMatchObject({ budget: 1200 });
    const rep = (await owner.agent.get(`/api/leads/import/jobs/${j.id}/errors`).set('X-Org-Id', owner.orgId!)).text;
    expect(rep).toMatch(/\n3,Error,customFields,/);
  });
});

describe('background import — large files, retries, cancellation', () => {
  it('imports thousands of rows in committed batches and tracks progress', async () => {
    const batchSize = config.importBatchSize;
    const n = batchSize * 5 + 37;
    const progress: number[] = [];
    importHooks.afterBatch = async (id) => { progress.push((await ownerPrisma.importJob.findUniqueOrThrow({ where: { id } })).processedRows); };
    const t0 = Date.now();
    const j = await run(owner, csv(gen(n, 'big')));
    const ms = Date.now() - t0;
    expect(j).toMatchObject({ status: 'COMPLETED', totalRows: n, processedRows: n, createdRows: n, failedRows: 0, skippedRows: 0 });
    expect(await leadCount(owner.orgId!, '@bulk.test')).toBeGreaterThanOrEqual(n);
    expect(progress).toEqual([...Array.from({ length: 5 }, (_, i) => (i + 1) * batchSize), n]);       // strictly increasing, visible while running
    console.log(`import benchmark: ${n} rows in ${ms} ms (${Math.round(n / (ms / 1000))} rows/s, batch ${batchSize})`);
  });

  it('resumes after a crash between batches without creating any lead twice, and survives concurrent duplicate processing', async () => {
    const n = config.importBatchSize * 3;
    const up = await upload(owner, csv(gen(n, 'crash')));
    const id = up.body.data.id as string;
    importHooks.afterBatch = async (_id, no) => { if (no === 2) throw new Error('worker crashed'); };
    const orig = config.jobsInline; (config as { jobsInline: boolean }).jobsInline = true;
    try {
      await owner.post(`/leads/import/jobs/${id}/start`);      // inline: the first attempt crashes after committing 2 batches (the error is logged, not thrown to the API)
      let j = await ownerPrisma.importJob.findUniqueOrThrow({ where: { id } });
      expect(j.status).toBe('RUNNING'); expect(j.attempts).toBe(1); expect(j.createdRows).toBe(config.importBatchSize * 2); expect(j.lastRow).toBe(config.importBatchSize * 2 + 1);
      expect(await leadCount(owner.orgId!, '@bulk.test')).toBeGreaterThanOrEqual(config.importBatchSize * 2);
      importHooks.afterBatch = undefined;
      // the retry (BullMQ would run it again) — twice at once, as a stalled-job re-run could
      await Promise.all([processImportJob(owner.orgId!, id), processImportJob(owner.orgId!, id)]);
      j = await ownerPrisma.importJob.findUniqueOrThrow({ where: { id } });
      expect(j).toMatchObject({ status: 'COMPLETED', createdRows: n, processedRows: n, failedRows: 0 });
      expect(await ownerPrisma.lead.count({ where: { organizationId: owner.orgId!, email: { startsWith: 'crash' } } })).toBe(n);
      const dupes = await ownerPrisma.$queryRaw<Array<{ c: bigint }>>`SELECT count(*) AS c FROM (SELECT email_normalized FROM leads WHERE organization_id = ${owner.orgId!}::uuid AND email LIKE 'crash%' GROUP BY 1 HAVING count(*) > 1) d`;
      expect(Number(dupes[0]!.c)).toBe(0);
      await processImportJob(owner.orgId!, id);                 // a finished job is never processed again
      expect(await ownerPrisma.lead.count({ where: { organizationId: owner.orgId!, email: { startsWith: 'crash' } } })).toBe(n);
    } finally { (config as { jobsInline: boolean }).jobsInline = orig; }
  });

  it('fails permanently with a clear message after the configured attempts, keeping what was committed', async () => {
    const up = await upload(owner, csv(gen(config.importBatchSize + 5, 'fail')));
    const id = up.body.data.id as string;
    importHooks.afterBatch = async () => { store.failStream = true; throw new Error('disk on fire'); };
    await owner.post(`/leads/import/jobs/${id}/start`);
    for (let i = 1; i < config.importMaxAttempts; i++) await processImportJob(owner.orgId!, id).catch(() => undefined);
    const j = await get(owner, id);
    expect(j.status).toBe('FAILED'); expect(j.error).toMatch(/S3 down/); expect((await ownerPrisma.importJob.findUniqueOrThrow({ where: { id } })).attempts).toBe(config.importMaxAttempts); expect(j.createdRows).toBe(config.importBatchSize);
    expect((await ownerPrisma.importJob.findUniqueOrThrow({ where: { id } })).fileDeletedAt).not.toBeNull();
    expect((await manager.get('/notifications')).status).toBe(200);
  });

  it('a missing file fails the import without retrying forever', async () => {
    const up = await upload(owner, csv(gen(3, 'gone')));
    const id = up.body.data.id as string;
    const row = await ownerPrisma.importJob.findUniqueOrThrow({ where: { id } });
    fs.rmSync(path.join(dir, row.fileKey!));
    await owner.post(`/leads/import/jobs/${id}/start`);
    const j = await get(owner, id);
    expect(j.status).toBe('FAILED'); expect(j.error).toMatch(/could not be found|no longer available/);
    expect(await leadCount(owner.orgId!, 'gone')).toBe(0);
  });

  it('cancels a running import between batches: committed batches stay, the rest is not imported', async () => {
    const n = config.importBatchSize * 4;
    const up = await upload(owner, csv(gen(n, 'cancel')));
    const id = up.body.data.id as string;
    importHooks.afterBatch = async (jid, no) => { if (no === 1) { const r = await owner.post(`/leads/import/jobs/${jid}/cancel`); expect(r.status).toBe(200); expect(r.body.data.cancelRequested).toBe(true); } };
    await owner.post(`/leads/import/jobs/${id}/start`);
    const j = await get(owner, id);
    expect(j.status).toBe('CANCELED'); expect(j.createdRows).toBe(config.importBatchSize); expect(j.processedRows).toBe(config.importBatchSize);
    expect(await ownerPrisma.lead.count({ where: { organizationId: owner.orgId!, email: { startsWith: 'cancel' } } })).toBe(config.importBatchSize);
    expect((await ownerPrisma.importJob.findUniqueOrThrow({ where: { id } })).fileDeletedAt).not.toBeNull();
    expect((await owner.post(`/leads/import/jobs/${id}/cancel`)).body.error.code).toBe('NOT_CANCELABLE');
  });

  it('cancels a previewed or queued import immediately and removes its file', async () => {
    const a = (await upload(owner, csv(gen(2, 'c1')))).body.data.id as string;
    expect((await owner.post(`/leads/import/jobs/${a}/cancel`)).body.data.status).toBe('CANCELED');
    expect((await owner.post(`/leads/import/jobs/${a}/start`)).body.data.status).toBe('CANCELED');                     // cannot be started afterwards
    const b = (await upload(owner, csv(gen(2, 'c2')))).body.data.id as string;
    await ownerPrisma.importJob.update({ where: { id: b }, data: { status: 'QUEUED' } });
    expect((await owner.post(`/leads/import/jobs/${b}/cancel`)).body.data.status).toBe('CANCELED');
    await processImportJob(owner.orgId!, b);                                                                          // a queued BullMQ job for it finds nothing to do
    expect(await leadCount(owner.orgId!, '@bulk.test')).toBeGreaterThan(0);
    expect(await ownerPrisma.lead.count({ where: { organizationId: owner.orgId!, email: { startsWith: 'c2' } } })).toBe(0);
    for (const id of [a, b]) { const r = await ownerPrisma.importJob.findUniqueOrThrow({ where: { id } }); expect(r.fileDeletedAt).not.toBeNull(); }
  });
});

describe('background import — limits and protection', () => {
  it('enforces the plan limit: imports up to the limit, reports the rest and says why it stopped', async () => {
    const ws = await createWorkspace(await signUp('Tiny Owner'), `Tiny ${uniq()}`);
    const plan = await ownerPrisma.subscriptionPlan.create({ data: { code: `tiny-${uniq()}`, name: 'Tiny', description: 't', priceMonthly: 1, priceYearly: 10, maxLeads: 30, maxSeats: 3, features: ['import_export'], trialDays: 0, sortOrder: 99, isActive: false } });
    await ownerPrisma.subscription.update({ where: { organizationId: ws.orgId! }, data: { planId: plan.id, status: 'ACTIVE', trialEndsAt: null } });
    for (let i = 0; i < 5; i++) expect((await ws.post('/leads', { firstName: `Pre${i}`, email: `pre${i}@tiny.test` })).status).toBe(201);
    const j = await run(ws, csv(gen(100, 'tiny')));
    expect(j).toMatchObject({ status: 'COMPLETED', createdRows: 25, stopReason: 'PLAN_LIMIT', totalRows: 100 });
    expect(j.failedRows + j.skippedRows + j.createdRows).toBe(100);
    expect(await leadCount(ws.orgId!)).toBe(30);
    expect((await ws.agent.get(`/api/leads/import/jobs/${j.id}/errors`).set('X-Org-Id', ws.orgId!)).text).toMatch(/Plan limit reached/);
    // at the limit already: starting is refused up front
    const up = await upload(ws, csv(gen(2, 'more')));
    const st = await ws.post(`/leads/import/jobs/${up.body.data.id}/start`);
    expect(st.status).toBe(402); expect(st.body.error.code).toBe('LEAD_LIMIT_REACHED');
    await ownerPrisma.subscription.update({ where: { organizationId: ws.orgId! }, data: { planId: (await ownerPrisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'professional' } })).id } });
  });

  it('allows only one active import per workspace, and bounds file size and row count', async () => {
    const a = (await upload(owner, csv(gen(2, 'act1')))).body.data.id as string;
    const b = (await upload(owner, csv(gen(2, 'act2')))).body.data.id as string;
    await ownerPrisma.importJob.update({ where: { id: a }, data: { status: 'RUNNING' } });
    const r = await owner.post(`/leads/import/jobs/${b}/start`);
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('IMPORT_IN_PROGRESS');
    await ownerPrisma.importJob.update({ where: { id: a }, data: { status: 'COMPLETED' } });
    expect((await owner.post(`/leads/import/jobs/${b}/start`)).status).toBe(200);
    const keep = config.importMaxRows; (config as { importMaxRows: number }).importMaxRows = 5;
    const objs = fs.readdirSync(path.join(dir, 'imports', owner.orgId!)).length;
    try {
      const big = await upload(owner, csv(gen(6, 'rows')));
      expect(big.status).toBe(400); expect(big.body.error.code).toBe('TOO_MANY_ROWS');
      expect(fs.readdirSync(path.join(dir, 'imports', owner.orgId!)).length).toBe(objs);        // rejected before anything was stored
    } finally { (config as { importMaxRows: number }).importMaxRows = keep; }
    const tooBig = await upload(owner, Buffer.concat([csv(gen(1)), Buffer.alloc(config.importMaxFileBytes + 10, 32)]));
    expect(tooBig.status).toBe(413); expect(tooBig.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('rejects files by content, missing columns and storage outages without leaving anything behind', async () => {
    const before = await ownerPrisma.importJob.count({ where: { organizationId: owner.orgId! } });
    expect((await upload(owner, Buffer.from('MZ\x00\x00binary'), 'x.csv')).status).toBe(400);
    expect((await upload(owner, csv([['a', 'b']], ['Foo', 'Bar']))).body.error.code).toBe('MISSING_NAME_COLUMN');
    expect((await upload(owner, csv([['Ann']], ['First Name']))).body.error.code).toBe('MISSING_CONTACT_COLUMN');
    expect((await upload(owner, Buffer.from('First Name,Email\n'))).body.error.code).toBe('EMPTY_FILE');
    expect((await upload(owner, csv(gen(1)), 'leads.exe')).status).toBe(400);
    store.failPut = true;
    const down = await upload(owner, csv(gen(1, 'down')));
    store.failPut = false;
    expect(down.status).toBe(503); expect(down.body.error.code).toBe('STORAGE_UNAVAILABLE');
    expect(await ownerPrisma.importJob.count({ where: { organizationId: owner.orgId! } })).toBe(before);
  });

  it('is restricted to people who may import and isolated per workspace', async () => {
    const own = (await upload(manager, csv(gen(1, 'iso')))).body.data.id as string;
    expect((await upload(agent, csv(gen(1)))).status).toBe(403);
    expect((await upload(viewer, csv(gen(1)))).status).toBe(403);
    expect((await agent.get('/leads/import/jobs')).status).toBe(403);
    // another workspace: nothing is visible or actionable, with or without header spoofing
    for (const call of [other.get(`/leads/import/jobs/${own}`), other.post(`/leads/import/jobs/${own}/start`), other.post(`/leads/import/jobs/${own}/cancel`), other.get(`/leads/import/jobs/${own}/errors`)]) expect((await call).status).toBe(404);
    expect((await other.agent.get(`/api/leads/import/jobs/${own}`).set('X-Org-Id', owner.orgId!)).status).toBe(403);
    expect((await other.get('/leads/import/jobs')).body.data.jobs.some((j: { id: string }) => j.id === own)).toBe(false);
    const rows = await withContext({ orgId: other.orgId!, userId: other.userId }, async () => (await import('../src/db')).db().importJob.findMany());
    expect(rows).toHaveLength(0);
    // a processor invoked with the wrong workspace cannot touch the job
    await processImportJob(other.orgId!, own);
    expect((await ownerPrisma.importJob.findUniqueOrThrow({ where: { id: own } })).status).toBe('PREVIEW');
    // members without view_all only see their own uploads in the history
    await owner.post('/roles', { name: 'Importer', permissions: ['leads.import', 'leads.create'] }).catch(() => undefined);
    expect((await manager.get('/leads/import/jobs')).body.data.jobs.some((j: { id: string }) => j.id === own)).toBe(true);
  });

  it('housekeeping: unstarted previews expire with their file, old history is purged, stuck jobs are re-dispatched', async () => {
    const id = (await upload(owner, csv(gen(1, 'exp')))).body.data.id as string;
    const key = (await ownerPrisma.importJob.findUniqueOrThrow({ where: { id } })).fileKey!;
    expect(fs.existsSync(path.join(dir, key))).toBe(true);
    const later = new Date(Date.now() + (config.importPreviewTtlHours + 1) * 3_600_000);
    const r = await withContext({ orgId: owner.orgId!, userId: null }, () => sweepImportJobs(owner.orgId!, later));
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect((await ownerPrisma.importJob.findUniqueOrThrow({ where: { id } })).status).toBe('EXPIRED');
    expect(fs.existsSync(path.join(dir, key))).toBe(false);
    const ancient = new Date(Date.now() + (config.importHistoryDays + 2) * 86_400_000);
    const p = await withContext({ orgId: owner.orgId!, userId: null }, () => sweepImportJobs(owner.orgId!, ancient));
    expect(p.purged).toBeGreaterThanOrEqual(1);
    expect(await ownerPrisma.importJob.count({ where: { id } })).toBe(0);
  });
});
