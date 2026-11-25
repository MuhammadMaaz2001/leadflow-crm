import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Storage, setObjectStorage, presentLogo } from '../src/lib/storage';
import { addMember, boot, createWorkspace, ownerPrisma, signUp, uniq, type Actor } from './helpers';

// Minimal in-process S3 API (path-style PUT/GET/DELETE object). It does not verify SigV4 signatures, so this proves the
// application's use of an S3 client (keys, content types, private serving, cleanup) — NOT compatibility with a particular vendor.
const objects = new Map<string, { body: Buffer; type: string }>();
const calls: string[] = [];
let server: http.Server; let endpoint = '';
beforeAll(async () => {
  await boot();
  server = http.createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? '').split('?')[0]!);
    calls.push(`${req.method} ${key}`);
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET' && (req.url ?? '').includes('list-type=2')) {
        const prefix = new URL(req.url!, 'http://x').searchParams.get('prefix') ?? '';
        const items = [...objects.keys()].filter((k) => k.startsWith(`/leadflow-test/${prefix}`)).map((k) => `<Contents><Key>${k.slice('/leadflow-test/'.length)}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>1</Size></Contents>`).join('');
        res.writeHead(200, { 'content-type': 'application/xml' }).end(`<?xml version="1.0"?><ListBucketResult><Name>leadflow-test</Name><Prefix>${prefix}</Prefix><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`);
      } else if (req.method === 'PUT') { objects.set(key, { body: Buffer.concat(chunks), type: String(req.headers['content-type']) }); res.writeHead(200, { ETag: '"x"' }).end(); }
      else if (req.method === 'GET') { const o = objects.get(key); if (!o) { res.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>'); } else res.writeHead(200, { 'content-type': o.type, 'content-length': o.body.length }).end(o.body); }
      else if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); }
      else res.writeHead(405).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setObjectStorage(new S3Storage({ endpoint, region: 'us-east-1', bucket: 'leadflow-test', accessKeyId: 'test', secretAccessKey: 'test', forcePathStyle: true }));
});
afterAll(async () => { setObjectStorage(null); await new Promise((r) => server.close(r)); });

// 1×1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';

describe('object storage for logos (S3-compatible)', () => {
  let owner: Actor, agent: Actor, outsider: Actor;
  beforeAll(async () => {
    owner = await createWorkspace(await signUp('Store Owner'), `Store ${uniq()}`);
    agent = await addMember(owner, 'SALES_AGENT');
    outsider = await signUp('Outsider');
  });

  it('stores the image in the bucket, keeps only a key in PostgreSQL and returns an authenticated URL', async () => {
    const r = await owner.patch('/organizations/current', { logoData: PNG });
    expect(r.status).toBe(200);
    expect(r.body.data.logoData).toMatch(new RegExp(`^/api/organizations/${owner.orgId}/logo\\?v=[0-9a-f]{12}$`));
    const row = await ownerPrisma.organization.findUniqueOrThrow({ where: { id: owner.orgId! } });
    expect(row.logoData).toMatch(/^storage:logos\/[0-9a-f-]{36}\/[0-9a-f]{24}\.png$/);
    expect(row.logoData).not.toContain('base64');
    const key = `/leadflow-test/${row.logoData!.slice('storage:'.length)}`;
    expect(objects.get(key)?.type).toBe('image/png');
    expect(objects.get(key)?.body.subarray(1, 4).toString()).toBe('PNG');
  });

  it('serves the logo to members only, with safe headers', async () => {
    const url = (await owner.get('/organizations/current')).body.data.organization.logoData as string;
    const ok = await agent.agent.get(url);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.headers['cache-control']).toContain('private');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['content-security-policy']).toContain('sandbox');
    expect((await outsider.agent.get(url)).status).toBe(404);                       // a signed-in non-member sees nothing
    expect((await (await import('supertest')).default((await import('../src/app')).createApp({ rateLimit: false })).get(url)).status).toBe(401);  // anonymous
    // workspaces list (used by the switcher) exposes the same URL, never a bucket URL or credentials
    const me = (await agent.agent.get('/api/auth/me')).body.data;
    expect(JSON.stringify(me)).not.toMatch(/leadflow-test|127\.0\.0\.1|accessKey/);
  });

  it('saving the settings form with the unchanged logo URL keeps the object; replacing it deletes the old object; removing deletes all', async () => {
    const url = (await owner.get('/organizations/current')).body.data.organization.logoData as string;
    expect((await owner.patch('/organizations/current', { logoData: url, name: 'Renamed Co' })).status).toBe(200);
    const before = [...objects.keys()].filter((k) => k.includes(`/logos/${owner.orgId}/`));
    expect(before).toHaveLength(1);
    expect((await owner.patch('/organizations/current', { logoData: GIF })).status).toBe(200);
    const after = [...objects.keys()].filter((k) => k.includes(`/logos/${owner.orgId}/`));
    expect(after).toHaveLength(1); expect(after[0]).not.toBe(before[0]);
    expect(after[0]).toMatch(/\.gif$/);
    expect((await owner.patch('/organizations/current', { logoData: null })).status).toBe(200);
    expect([...objects.keys()].filter((k) => k.includes(`/logos/${owner.orgId}/`))).toHaveLength(0);
    expect((await owner.get('/organizations/current')).body.data.organization.logoData).toBeNull();
  });

  it('still validates content before anything reaches the bucket', async () => {
    const n = objects.size;
    expect((await owner.patch('/organizations/current', { logoData: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).status).toBe(400);
    expect((await owner.patch('/organizations/current', { logoData: 'data:image/png;base64,' + Buffer.from('<html>').toString('base64') })).status).toBe(400);
    expect(objects.size).toBe(n);
  });

  it('presentLogo passes inline data URLs through (db provider) and rewrites storage keys', () => {
    expect(presentLogo('o', PNG)).toBe(PNG);
    expect(presentLogo('o', null)).toBeNull();
    expect(presentLogo('0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12), 'storage:logos/x/y.png')).toMatch(/^\/api\/organizations\/.+\/logo\?v=/);
  });
});

describe('object storage failures and private-bucket behaviour', () => {
  it('a storage outage never changes the workspace, never leaks internals, and uploads need no public access', async () => {
    const owner = await createWorkspace(await signUp('Fail Owner'), `StoreF ${uniq()}`);
    const before = (await ownerPrisma.organization.findUniqueOrThrow({ where: { id: owner.orgId! } })).logoData;
    const failing = new S3Storage({ endpoint: 'http://127.0.0.1:1', region: 'us-east-1', bucket: 'leadflow-test', accessKeyId: 'test', secretAccessKey: 'test', forcePathStyle: true });
    setObjectStorage(failing);
    try {
      const r = await owner.patch('/organizations/current', { logoData: PNG });
      expect(r.status).toBe(503); expect(r.body.error.code).toBe('STORAGE_UNAVAILABLE');
      expect(JSON.stringify(r.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|leadflow-test/);
      expect((await ownerPrisma.organization.findUniqueOrThrow({ where: { id: owner.orgId! } })).logoData).toBe(before);
    } finally { setObjectStorage(new S3Storage({ endpoint, region: 'us-east-1', bucket: 'leadflow-test', accessKeyId: 'test', secretAccessKey: 'test', forcePathStyle: true })); }
    // the bytes only ever travel with the application's credentials: the fake bucket would accept anonymous reads, the app never hands out such a URL
    const ok = await owner.patch('/organizations/current', { logoData: PNG });
    expect(ok.status).toBe(200);
    const url = ok.body.data.logoData as string;
    expect(url.startsWith('/api/organizations/')).toBe(true);                       // an application route, not a bucket URL
    expect(url).not.toMatch(/^https?:/);
    const key = [...objects.keys()].find((k) => k.includes(`/logos/${owner.orgId}/`))!;
    expect(key).toMatch(/^\/leadflow-test\/logos\/[0-9a-f-]{36}\/[0-9a-f]{24}\.png$/);          // server-generated key: org id + content hash, never a user supplied name
  });

  it('lists objects under a prefix (used by the attachment orphan sweeper)', async () => {
    const st = new S3Storage({ endpoint, region: 'us-east-1', bucket: 'leadflow-test', accessKeyId: 'test', secretAccessKey: 'test', forcePathStyle: true });
    await st.put('attachments/org-1/l/a.pdf', Buffer.from('x'), 'application/pdf'); await st.put('attachments/org-2/l/b.pdf', Buffer.from('y'), 'application/pdf');
    const l = await st.list('attachments/org-1/');
    expect(l.map((o) => o.key)).toEqual(['attachments/org-1/l/a.pdf']);
    expect(l[0]!.lastModified).toBeInstanceOf(Date);
    await st.delete('attachments/org-1/l/a.pdf'); await st.delete('attachments/org-2/l/b.pdf');
  });
});
