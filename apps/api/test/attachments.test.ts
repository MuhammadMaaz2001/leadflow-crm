import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { withContext } from '../src/db';
import { LocalDiskStorage, setObjectStorage, type ObjectStorage } from '../src/lib/storage';
import { purgeWorkspaceAttachments, sweepAttachments } from '../src/modules/attachments/service';
import { addMember, boot, createWorkspace, ownerPrisma, signUp, uniq, type Actor } from './helpers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** In-memory object store with switchable failures, so storage outages can be tested deterministically. */
class MemoryStorage implements ObjectStorage {
  name = 'memory';
  objects = new Map<string, { body: Buffer; contentType: string; at: Date }>();
  failPut = false; failGet = false; failDelete = false; putsBeforeFail = Infinity;
  async put(key: string, body: Buffer, contentType: string) {
    if (this.failPut || this.putsBeforeFail-- <= 0) throw new Error('S3 down');
    this.objects.set(key, { body, contentType, at: new Date() });
  }
  async get(key: string) { if (this.failGet) throw new Error('S3 down'); const o = this.objects.get(key); return o ? { body: o.body, contentType: o.contentType } : null; }
  async delete(key: string) { if (this.failDelete) throw new Error('S3 down'); this.objects.delete(key); }
  async list(prefix: string) { return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, lastModified: o.at })); }
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(30, 3)]);
const CSV = Buffer.from('name,email\nJane,jane@example.com\n');
/** Minimal ZIP container with stored entries (enough for the central-directory checks the validator performs). */
function zip(names: string[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []; let off = 0;
  for (const n of names) {
    const nb = Buffer.from(n); const data = Buffer.from('x');
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, data); centrals.push(ch, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const DOCX = zip(['[Content_Types].xml', 'word/document.xml']);
const XLSX_BAD_MACRO = zip(['[Content_Types].xml', 'xl/workbook.xml', 'xl/vbaProject.bin']);
let XLSX: Buffer;

interface F { name: string; data: Buffer; type?: string }
const upload = (a: Actor, leadId: string, files: F[]) => {
  let r = a.agent.post(`/api/leads/${leadId}/attachments`).set('X-Org-Id', a.orgId!);
  for (const f of files) r = r.attach('files', f.data, { filename: f.name, contentType: f.type ?? 'application/octet-stream' });
  return r;
};

let store: MemoryStorage;
let owner: Actor, manager: Actor, agentA: Actor, agentB: Actor, viewer: Actor, other: Actor;
let leadA: string;     // owned by agent A
let leadM: string;     // owned by the manager
beforeAll(async () => {
  await boot();
  store = new MemoryStorage(); setObjectStorage(store);
  XLSX = Buffer.from(await (async () => { const wb = new ExcelJS.Workbook(); wb.addWorksheet('s').addRow(['a', 'b']); return wb.xlsx.writeBuffer(); })());
  owner = await createWorkspace(await signUp('Att Owner'), `Att ${uniq()}`);
  manager = await addMember(owner, 'MANAGER', 'Mia Manager'); agentA = await addMember(owner, 'SALES_AGENT', 'Agent A'); agentB = await addMember(owner, 'SALES_AGENT', 'Agent B'); viewer = await addMember(owner, 'VIEWER', 'Vic Viewer');
  other = await createWorkspace(await signUp('Other Owner'), `AttB ${uniq()}`);
  leadA = (await agentA.post('/leads', { firstName: 'Alpha', email: `alpha-${uniq()}@x.test` })).body.data.id;
  leadM = (await manager.post('/leads', { firstName: 'Mike', email: `mike-${uniq()}@x.test`, assignedToId: manager.userId })).body.data.id;
});
afterAll(() => { setObjectStorage(null); });

describe('lead attachments — upload', () => {
  it('stores several valid files in object storage, keeps only metadata in PostgreSQL and exposes no storage keys', async () => {
    const r = await upload(agentA, leadA, [{ name: 'Proposal 2026.pdf', data: PDF, type: 'application/pdf' }, { name: 'photo.JPG', data: JPG, type: 'image/jpeg' }, { name: 'logo.png', data: PNG, type: 'image/png' }, { name: 'banner.webp', data: WEBP }, { name: 'contacts.csv', data: CSV, type: 'application/vnd.ms-excel' }, { name: 'sheet.xlsx', data: XLSX }, { name: 'brief.docx', data: DOCX }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.uploaded).toHaveLength(7);
    expect(r.body.data.rejected).toHaveLength(0);
    const list = (await agentA.get(`/leads/${leadA}/attachments`)).body.data;
    expect(list.items).toHaveLength(7);
    const pdf = list.items.find((i: { name: string }) => i.name === 'Proposal 2026.pdf');
    expect(pdf).toMatchObject({ contentType: 'application/pdf', extension: 'pdf', size: PDF.length, uploadedBy: { name: 'Agent A' } });
    expect(Date.parse(pdf.uploadedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(JSON.stringify(list)).not.toMatch(/attachments\/|storageKey|s3|bucket/i);
    expect(list.limits).toMatchObject({ maxBytes: config.attachmentMaxBytes, enabled: true });
    const rows = await ownerPrisma.leadAttachment.findMany({ where: { leadId: leadA } });
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.storageKey).toMatch(new RegExp(`^attachments/${owner.orgId}/${leadA}/[0-9a-f-]{36}\\.(pdf|jpg|png|webp|csv|xlsx|docx)$`));
      expect(row.storageKey).not.toMatch(/proposal|photo|brief/i);          // client-chosen names never reach the object key
      expect(store.objects.get(row.storageKey)?.contentType).toBe(row.contentType);
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const tl = (await agentA.get(`/leads/${leadA}/activities?type=ATTACHMENT_ADDED`)).body.data;
    expect(tl).toHaveLength(7);
    expect(tl[0].title).toMatch(/^Attached "/);
    // the lead's owner is not notified about their own upload; a manager's upload notifies the owner
    await upload(manager, leadA, [{ name: 'extra.pdf', data: PDF }]);
    const notes = (await agentA.get('/notifications')).body.data as Array<{ title: string; link: string }>;
    expect(notes.some((n) => /Mia Manager attached a file to Alpha/.test(n.title) && n.link === `/leads/${leadA}`)).toBe(true);
  });

  it('validates the CONTENT, not the file name or the declared type', async () => {
    const bad = async (f: F, status: number, code: string) => { const r = await upload(agentA, leadA, [f]); expect(r.status, `${f.name}: ${JSON.stringify(r.body)}`).toBe(status); expect(r.body.error.code, f.name).toBe(code); };
    await bad({ name: 'run.pdf', data: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]) }, 415, 'FORBIDDEN_FILE');                 // Windows executable renamed
    await bad({ name: 'script.csv', data: Buffer.from('#!/bin/sh\nrm -rf /\n') }, 415, 'FORBIDDEN_FILE');
    await bad({ name: 'page.csv', data: Buffer.from('<html><script>alert(1)</script></html>') }, 415, 'FORBIDDEN_FILE');
    await bad({ name: 'vector.png', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>') }, 415, 'FORBIDDEN_FILE');
    await bad({ name: 'image.pdf', data: PNG }, 415, 'CONTENT_MISMATCH');                                                              // real PNG, wrong extension
    await bad({ name: 'doc.docx', data: XLSX }, 415, 'CONTENT_MISMATCH');                                                           // spreadsheet claiming to be Word
    await bad({ name: 'macro.xlsx', data: XLSX_BAD_MACRO }, 415, 'FORBIDDEN_FILE');
    await bad({ name: 'tool.exe', data: PDF }, 415, 'UNSUPPORTED_FILE');
    await bad({ name: 'noext', data: PDF }, 415, 'UNSUPPORTED_FILE');
    await bad({ name: 'blob.csv', data: Buffer.from([1, 2, 3, 0, 4, 5]) }, 415, 'UNSUPPORTED_FILE');                                 // binary pretending to be text
    await bad({ name: 'doc.pdf', data: PDF, type: 'image/png' }, 415, 'CONTENT_MISMATCH');                                          // declared type contradicts the bytes
    await bad({ name: 'empty.pdf', data: Buffer.alloc(0) }, 400, 'EMPTY_FILE');
    expect(await ownerPrisma.leadAttachment.count({ where: { leadId: leadA, originalName: { in: ['run.pdf', 'tool.exe', 'noext'] } } })).toBe(0);
  });

  it('enforces the size limit, the per-request file count, and reports mixed uploads file by file', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(config.attachmentMaxBytes)]);
    const r = await upload(agentA, leadA, [{ name: 'big.pdf', data: big }]);
    expect(r.status).toBe(413); expect(r.body.error.code).toBe('FILE_TOO_LARGE');
    const many = await upload(agentA, leadA, Array.from({ length: config.attachmentMaxFilesPerRequest + 1 }, (_, i) => ({ name: `f${i}.pdf`, data: PDF })));
    expect(many.status).toBe(400); expect(many.body.error.code).toBe('TOO_MANY_FILES');
    const before = await ownerPrisma.leadAttachment.count({ where: { leadId: leadA } });
    const mixed = await upload(agentA, leadA, [{ name: 'good.pdf', data: PDF }, { name: 'evil.pdf', data: Buffer.from('MZxxxx') }, { name: 'fine.png', data: PNG }]);
    expect(mixed.status).toBe(201);
    expect(mixed.body.data.uploaded.map((u: { name: string }) => u.name).sort()).toEqual(['fine.png', 'good.pdf']);
    expect(mixed.body.data.rejected).toEqual([expect.objectContaining({ name: 'evil.pdf', code: 'FORBIDDEN_FILE' })]);
    expect(await ownerPrisma.leadAttachment.count({ where: { leadId: leadA } })).toBe(before + 2);
  });

  it('neutralises hostile file names: no path components, control characters or traversal ever reach the key or the headers', async () => {
    const r = await upload(agentA, leadA, [{ name: '../../etc/passwd\u202etxt.pdf', data: PDF }, { name: 'C:\\Windows\\evil\n"name.pdf', data: PDF }]);
    expect(r.status).toBe(201);
    for (const u of r.body.data.uploaded as Array<{ id: string; name: string }>) {
      expect(u.name).not.toMatch(/[\\/\n"\u202e]|\.\./);
      const row = await ownerPrisma.leadAttachment.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.storageKey).toMatch(/^attachments\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/);
      const d = await agentA.get(`/leads/${leadA}/attachments/${u.id}/download`);
      expect(d.status).toBe(200);
      expect(d.headers['content-disposition']).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
      expect(d.headers['content-disposition']).not.toMatch(/\n|\.\.\//);
    }
  });

  it('the local-disk adapter (dev/test) cannot be tricked into leaving its root', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-store-'));
    const st = new LocalDiskStorage(dir);
    await st.put('attachments/o/l/a.pdf', PDF, 'application/pdf');
    expect((await st.get('attachments/o/l/a.pdf'))?.contentType).toBe('application/pdf');
    expect((await st.list('attachments/o/')).map((o) => o.key)).toEqual(['attachments/o/l/a.pdf']);
    for (const k of ['../escape.pdf', 'attachments/../../escape.pdf', '/etc/passwd', 'a/./b', 'attachments/o/l/..%2f..%2fx']) await expect(st.put(k, PDF, 'x'), k).rejects.toThrow(/invalid storage key/);
    expect(fs.readdirSync(path.dirname(dir)).includes('escape.pdf')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('lead attachments — authorisation and tenant isolation', () => {
  let attId: string;
  beforeAll(async () => { attId = (await ownerPrisma.leadAttachment.findFirstOrThrow({ where: { leadId: leadA, originalName: 'Proposal 2026.pdf' } })).id; });

  it('serves the exact bytes with download-only, sandboxed, non-cacheable headers to people who may see the lead', async () => {
    for (const who of [agentA, manager, owner, viewer]) {
      const d = await who.agent.get(`/api/leads/${leadA}/attachments/${attId}/download`).set('X-Org-Id', owner.orgId!).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
      expect(d.status).toBe(200);
      expect(Buffer.compare(d.body as Buffer, PDF)).toBe(0);
      expect(d.headers['content-type']).toBe('application/pdf');
      expect(d.headers['content-disposition']).toMatch(/^attachment;/);
      expect(d.headers['x-content-type-options']).toBe('nosniff');
      expect(d.headers['content-security-policy']).toContain('sandbox');
      expect(d.headers['cache-control']).toMatch(/no-store/);
    }
  });

  it('hides a lead\'s files from agents who cannot see the lead, and viewers cannot write', async () => {
    expect((await agentB.get(`/leads/${leadA}/attachments`)).status).toBe(404);
    expect((await agentB.get(`/leads/${leadA}/attachments/${attId}/download`)).status).toBe(404);
    expect((await upload(agentB, leadA, [{ name: 'x.pdf', data: PDF }])).status).toBe(404);
    expect((await agentB.del(`/leads/${leadA}/attachments/${attId}`)).status).toBe(404);
    expect((await upload(viewer, leadA, [{ name: 'x.pdf', data: PDF }])).status).toBe(403);
    expect((await viewer.del(`/leads/${leadA}/attachments/${attId}`)).status).toBe(403);
    expect((await agentA.agent.get(`/api/leads/${leadA}/attachments/${attId}/download`)).status).toBe(400);   // no workspace header
    const anon = await (await import('./helpers')).request(((await import('./helpers')).app)).get(`/api/leads/${leadA}/attachments/${attId}/download`).set('X-Org-Id', owner.orgId!);
    expect(anon.status).toBe(401);
  });

  it('never crosses workspaces: another tenant cannot list, download, upload to or delete, with or without spoofed headers', async () => {
    expect((await other.get(`/leads/${leadA}/attachments`)).status).toBe(404);
    expect((await other.get(`/leads/${leadA}/attachments/${attId}/download`)).status).toBe(404);
    expect((await upload(other, leadA, [{ name: 'x.pdf', data: PDF }])).status).toBe(404);
    expect((await other.del(`/leads/${leadA}/attachments/${attId}`)).status).toBe(404);
    const spoof = await other.agent.get(`/api/leads/${leadA}/attachments/${attId}/download`).set('X-Org-Id', owner.orgId!);
    expect(spoof.status).toBe(403);
    // an attachment id of this workspace cannot be fetched through a different lead of the same workspace
    const m = await manager.get(`/leads/${leadM}/attachments/${attId}/download`);
    expect(m.status).toBe(404);
    // RLS is a second line of defence: as the app role scoped to the other workspace the rows are invisible
    const rows = await withContext({ orgId: other.orgId!, userId: other.userId }, async () => (await import('../src/db')).db().leadAttachment.findMany());
    expect(rows).toHaveLength(0);
  });
});

describe('lead attachments — deletion', () => {
  it('lets the uploader or a manager remove a file; the object is deleted, history kept, timeline updated', async () => {
    const up = (await upload(agentA, leadA, [{ name: 'tmp1.pdf', data: PDF }, { name: 'tmp2.pdf', data: PDF }])).body.data.uploaded as Array<{ id: string }>;
    const row1 = await ownerPrisma.leadAttachment.findUniqueOrThrow({ where: { id: up[0]!.id } });
    expect(store.objects.has(row1.storageKey)).toBe(true);
    expect((await agentA.del(`/leads/${leadA}/attachments/${up[0]!.id}`)).status).toBe(200);          // the uploader
    expect((await manager.del(`/leads/${leadA}/attachments/${up[1]!.id}`)).status).toBe(200);         // a manager (leads.archive)
    for (const u of up) {
      expect((await agentA.get(`/leads/${leadA}/attachments/${u.id}/download`)).status).toBe(404);
      const row = await ownerPrisma.leadAttachment.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.deletedAt).not.toBeNull(); expect(row.storageDeletedAt).not.toBeNull(); expect(store.objects.has(row.storageKey)).toBe(false);
    }
    expect((await agentA.get(`/leads/${leadA}/attachments`)).body.data.items.some((i: { id: string }) => up.some((u) => u.id === i.id))).toBe(false);
    expect((await agentA.get(`/leads/${leadA}/activities?type=ATTACHMENT_REMOVED`)).body.data).toHaveLength(2);
    expect((await agentA.del(`/leads/${leadA}/attachments/${up[0]!.id}`)).status).toBe(404);             // already gone
    const audits = await ownerPrisma.auditLog.count({ where: { organizationId: owner.orgId!, action: 'lead.attachment_removed' } });
    expect(audits).toBeGreaterThanOrEqual(2);
  });

  it('only the uploader (with edit rights) or a manager may delete — not another editor', async () => {
    // agent B gets access to lead A by being its assignee after reassignment, but did not upload the files
    const mine = (await upload(manager, leadA, [{ name: 'by-manager.pdf', data: PDF }])).body.data.uploaded[0].id as string;
    expect((await owner.post(`/leads/${leadA}/assign`, { assignedToId: agentB.userId })).status).toBe(200);
    const denied = await agentB.del(`/leads/${leadA}/attachments/${mine}`);
    expect(denied.status).toBe(403); expect(denied.body.error.code).toBe('MISSING_PERMISSION');
    expect((await agentB.del(`/leads/${leadA}/attachments/${mine}`)).status).toBe(403);
    expect((await owner.del(`/leads/${leadA}/attachments/${mine}`)).status).toBe(200);
    expect((await owner.post(`/leads/${leadA}/assign`, { assignedToId: agentA.userId })).status).toBe(200);
  });

  it('archived leads keep their files readable but cannot be changed; merging moves the files to the surviving lead', async () => {
    const l1 = (await manager.post('/leads', { firstName: 'Dup', email: `dup1-${uniq()}@x.test` })).body.data.id as string;
    const l2 = (await manager.post('/leads', { firstName: 'Dup', email: `dup2-${uniq()}@x.test` })).body.data.id as string;
    const att = (await upload(manager, l1, [{ name: 'merge.pdf', data: PDF }])).body.data.uploaded[0].id as string;
    expect((await manager.post('/leads/merge', { sourceId: l1, targetId: l2 })).status).toBe(200);
    const moved = (await manager.get(`/leads/${l2}/attachments`)).body.data.items as Array<{ id: string }>;
    expect(moved.map((m) => m.id)).toContain(att);
    expect((await manager.get(`/leads/${l2}/attachments/${att}/download`)).status).toBe(200);
    expect((await manager.post(`/leads/${l2}/archive`)).status).toBe(200);
    expect((await manager.get(`/leads/${l2}/attachments/${att}/download`)).status).toBe(200);
    const list = (await manager.get(`/leads/${l2}/attachments`)).body.data;
    expect(list.canUpload).toBe(false);
    expect((await upload(manager, l2, [{ name: 'late.pdf', data: PDF }])).status).toBe(404);
    expect((await manager.del(`/leads/${l2}/attachments/${att}`)).status).toBe(409);
  });
});

describe('lead attachments — storage failure, limits and cleanup', () => {
  it('fails cleanly when storage is down: 503, nothing saved, no timeline entry; a half-finished upload leaves no object behind', async () => {
    const before = await ownerPrisma.leadAttachment.count({ where: { leadId: leadM } });
    store.failPut = true;
    const r = await upload(manager, leadM, [{ name: 'a.pdf', data: PDF }]);
    store.failPut = false;
    expect(r.status).toBe(503); expect(r.body.error.code).toBe('STORAGE_UNAVAILABLE');
    expect(await ownerPrisma.leadAttachment.count({ where: { leadId: leadM } })).toBe(before);
    expect((await manager.get(`/leads/${leadM}/activities?type=ATTACHMENT_ADDED`)).body.data).toHaveLength(0);
    // the second of three objects fails: the first (already written) is removed again and no rows remain
    const objectsBefore = store.objects.size; store.putsBeforeFail = 1;
    const r2 = await upload(manager, leadM, [{ name: 'a.pdf', data: PDF }, { name: 'b.pdf', data: PDF }, { name: 'c.pdf', data: PDF }]);
    store.putsBeforeFail = Infinity;
    expect(r2.status).toBe(503);
    expect(store.objects.size).toBe(objectsBefore);
    expect(await ownerPrisma.leadAttachment.count({ where: { leadId: leadM } })).toBe(before);
    // reads fail visibly too
    const ok = (await upload(manager, leadM, [{ name: 'ok.pdf', data: PDF }])).body.data.uploaded[0].id as string;
    store.failGet = true;
    const d = await manager.get(`/leads/${leadM}/attachments/${ok}/download`);
    store.failGet = false;
    expect(d.status).toBe(503); expect(d.body.error.code).toBe('STORAGE_UNAVAILABLE');
    expect((await manager.get(`/leads/${leadM}/attachments/${ok}/download`)).status).toBe(200);
  });

  it('a failed object delete never blocks the user; the sweeper finishes it. The sweeper also removes crashed-upload orphans, and nothing else', async () => {
    const id = (await upload(manager, leadM, [{ name: 'del.pdf', data: PDF }])).body.data.uploaded[0].id as string;
    const key = (await ownerPrisma.leadAttachment.findUniqueOrThrow({ where: { id } })).storageKey;
    store.failDelete = true;
    expect((await manager.del(`/leads/${leadM}/attachments/${id}`)).status).toBe(200);
    store.failDelete = false;
    expect(store.objects.has(key)).toBe(true);
    expect((await ownerPrisma.leadAttachment.findUniqueOrThrow({ where: { id } })).storageDeletedAt).toBeNull();
    // an orphan: object with no metadata row (the process died between the two steps), older than the grace period; plus a fresh in-flight one
    const orphan = `attachments/${owner.orgId}/${leadM}/orphan-${uniq()}.pdf`, fresh = `attachments/${owner.orgId}/${leadM}/fresh-${uniq()}.pdf`, foreign = `attachments/${other.orgId}/x/foreign.pdf`;
    store.objects.set(orphan, { body: PDF, contentType: 'application/pdf', at: new Date(Date.now() - 2 * 3_600_000) });
    store.objects.set(fresh, { body: PDF, contentType: 'application/pdf', at: new Date() });
    store.objects.set(foreign, { body: PDF, contentType: 'application/pdf', at: new Date(Date.now() - 5 * 3_600_000) });
    const live = (await ownerPrisma.leadAttachment.findFirstOrThrow({ where: { leadId: leadM, deletedAt: null } })).storageKey;
    const r = await withContext({ orgId: owner.orgId!, userId: null }, () => sweepAttachments(owner.orgId!));
    expect(r.deleted).toBeGreaterThanOrEqual(1); expect(r.orphans).toBe(1);
    expect(store.objects.has(key)).toBe(false); expect(store.objects.has(orphan)).toBe(false);
    expect(store.objects.has(fresh)).toBe(true);          // within the grace period: might still be uploading
    expect(store.objects.has(live)).toBe(true);           // referenced by a row
    expect(store.objects.has(foreign)).toBe(true);        // another workspace's prefix is never touched
    expect((await ownerPrisma.leadAttachment.findUniqueOrThrow({ where: { id } })).storageDeletedAt).not.toBeNull();
  });

  it('enforces the per-lead and per-workspace limits', async () => {
    const lead = (await manager.post('/leads', { firstName: 'Limits', email: `lim-${uniq()}@x.test` })).body.data.id as string;
    const keep = { perLead: config.attachmentMaxPerLead, quota: config.attachmentWorkspaceMaxBytes };
    try {
      (config as { attachmentMaxPerLead: number }).attachmentMaxPerLead = 2;
      const r = await upload(manager, lead, [{ name: '1.pdf', data: PDF }, { name: '2.pdf', data: PDF }, { name: '3.pdf', data: PDF }]);
      expect(r.status).toBe(201); expect(r.body.data.uploaded).toHaveLength(2); expect(r.body.data.rejected[0].code).toBe('ATTACHMENT_LIMIT');
      const again = await upload(manager, lead, [{ name: '4.pdf', data: PDF }]);
      expect(again.status).toBe(402); expect(again.body.error.code).toBe('ATTACHMENT_LIMIT');
      (config as { attachmentMaxPerLead: number }).attachmentMaxPerLead = keep.perLead;
      const used = Number((await ownerPrisma.leadAttachment.aggregate({ where: { organizationId: owner.orgId!, deletedAt: null }, _sum: { sizeBytes: true } }))._sum.sizeBytes);
      (config as { attachmentWorkspaceMaxBytes: number }).attachmentWorkspaceMaxBytes = used + PDF.length + 5;
      const q = await upload(manager, lead, [{ name: '5.pdf', data: PDF }, { name: '6.pdf', data: PDF }]);
      expect(q.status).toBe(201); expect(q.body.data.uploaded).toHaveLength(1); expect(q.body.data.rejected[0].code).toBe('STORAGE_QUOTA');
    } finally { (config as { attachmentMaxPerLead: number }).attachmentMaxPerLead = keep.perLead; (config as { attachmentWorkspaceMaxBytes: number }).attachmentWorkspaceMaxBytes = keep.quota; }
  });

  it('refuses to degrade silently without object storage in production, and purging a workspace removes every object', async () => {
    setObjectStorage(null);
    const wasProd = config.isProd; (config as { isProd: boolean }).isProd = true;
    try {
      const r = await upload(manager, leadM, [{ name: 'x.pdf', data: PDF }]);
      expect(r.status).toBe(503); expect(r.body.error.code).toBe('FEATURE_UNAVAILABLE');
      expect((await manager.get(`/leads/${leadM}/attachments`)).body.data.limits.enabled).toBe(false);
    } finally { (config as { isProd: boolean }).isProd = wasProd; setObjectStorage(store); }
    const n = [...store.objects.keys()].filter((k) => k.startsWith(`attachments/${owner.orgId}/`)).length;
    expect(n).toBeGreaterThan(0);
    const removed = await purgeWorkspaceAttachments(owner.orgId!);
    expect(removed).toBe(n);
    expect([...store.objects.keys()].some((k) => k.startsWith(`attachments/${owner.orgId}/`))).toBe(false);
    expect(store.objects.has(`attachments/${other.orgId}/x/foreign.pdf`)).toBe(true);
  });

  it('deleting a workspace removes the metadata with it, and a lead with attachments cannot be hard-deleted behind the application\'s back', async () => {
    const ws = await createWorkspace(await signUp('Doomed Owner'), `Doomed ${uniq()}`);
    const lead = (await ws.post('/leads', { firstName: 'D', email: `d-${uniq()}@x.test` })).body.data.id as string;
    const id = (await upload(ws, lead, [{ name: 'd.pdf', data: PDF }])).body.data.uploaded[0].id as string;
    await expect(ownerPrisma.lead.delete({ where: { id: lead } })).rejects.toThrow();
    await purgeWorkspaceAttachments(ws.orgId!);
    await ownerPrisma.organization.delete({ where: { id: ws.orgId! } });
    expect(await ownerPrisma.leadAttachment.count({ where: { id } })).toBe(0);
  });
});
