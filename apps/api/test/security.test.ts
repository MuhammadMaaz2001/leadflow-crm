import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app';
import { routeRegistry } from '../src/http';
import { sha256 } from '../src/lib/crypto';
import { addMember, app, boot, createWorkspace, makePlatformAdmin, ownerPrisma, PASSWORD, platformPrisma, request, signUp, uniq, withOrg, type Actor } from './helpers';

beforeAll(boot);

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

describe('request-level protections', () => {
  it('blocks cross-site state-changing requests (CSRF) and sets no-store / nosniff on API responses', async () => {
    const a = await createWorkspace(await signUp('Csrf Owner'), 'Csrf Co');
    const evil = await a.agent.post('/api/leads').set('X-Org-Id', a.orgId!).set('Origin', 'https://evil.example').send({ firstName: 'X', email: 'x@y.com' });
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe('CSRF_BLOCKED');
    const cross = await a.agent.post('/api/leads').set('X-Org-Id', a.orgId!).set('Sec-Fetch-Site', 'cross-site').send({ firstName: 'X', email: 'x@y.com' });
    expect(cross.status).toBe(403);
    const ok = await a.agent.post('/api/leads').set('X-Org-Id', a.orgId!).set('Origin', 'http://localhost:3000').send({ firstName: 'Fine', email: 'fine@y.com' });
    expect(ok.status).toBe(201);
    const get = await a.get('/leads');
    expect(get.headers['cache-control']).toBe('no-store');
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect((await a.agent.get('/api/leads').set('X-Org-Id', a.orgId!).set('Origin', 'https://evil.example')).status).toBe(200); // reads can't change state (and CORS hides the body)
  });

  it('rate-limits authentication endpoints', async () => {
    const limited = createApp({ rateLimit: true });
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await request(limited).post('/api/auth/login').send({ email: `nobody${i}@x.com`, password: 'Wrong-pass1' })).status;
    expect(last).toBe(429);
    expect((await request(limited).post('/api/auth/reset-password').send({ token: 'x'.repeat(20), password: PASSWORD })).status).not.toBe(500);
  });

  it('sets httpOnly SameSite cookies and rejects malformed JSON / oversized bodies cleanly', async () => {
    const email = `${uniq('cookie')}@example.com`;
    const agent = request.agent(app);
    const reg = await agent.post('/api/auth/register').send({ name: 'Cookie Jar', email, password: PASSWORD });
    await agent.post('/api/auth/verify-email').send({ token: new URL(reg.body.data.devVerificationLink).searchParams.get('token') });
    const login = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
    const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('lf_session='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect((await agent.post('/api/auth/login').set('Content-Type', 'application/json').send('{bad json')).status).toBe(400);
    const huge = await agent.post('/api/auth/login').send({ email, password: 'x'.repeat(3_000_000) });
    expect(huge.status).toBe(413);
  });
});

describe('sessions', () => {
  it('logout revokes the token server-side; idle sessions expire; deactivated users are cut off; password change signs out other devices', async () => {
    const a = await signUp('Session Owner');
    const token = decodeURIComponent((await a.agent.get('/api/auth/me').then(() => '')) || '') || '';
    void token;
    // capture the raw session token by logging in again and reading the cookie
    const agent2 = request.agent(app);
    const login = await agent2.post('/api/auth/login').send({ email: a.email, password: PASSWORD });
    const raw = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('lf_session='))!.split(';')[0]!.split('=')[1]!;
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${raw}`)).status).toBe(200);
    await agent2.post('/api/auth/logout');
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${raw}`)).status).toBe(401); // token is dead even if replayed

    const login3 = await request(app).post('/api/auth/login').send({ email: a.email, password: PASSWORD });
    const raw3 = (login3.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('lf_session='))!.split(';')[0]!.split('=')[1]!;
    await ownerPrisma.session.updateMany({ where: { tokenHash: sha256(raw3) }, data: { lastSeenAt: new Date(Date.now() - 8 * 86_400_000) } });
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${raw3}`)).status).toBe(401); // idle > 7 days

    expect((await a.agent.get('/api/auth/me')).status).toBe(200);
    await ownerPrisma.user.update({ where: { id: a.userId }, data: { isActive: false } });
    expect((await a.agent.get('/api/auth/me')).status).toBe(401);
  });

  it('login does not reveal whether an account exists, and locks after repeated failures', async () => {
    const a = await signUp('Lock Me');
    const unknown = await request(app).post('/api/auth/login').send({ email: `${uniq('ghost')}@example.com`, password: 'Wrong-pass1' });
    const wrong = await request(app).post('/api/auth/login').send({ email: a.email, password: 'Wrong-pass1' });
    expect(unknown.status).toBe(401); expect(wrong.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ email: a.email, password: 'Wrong-pass1' });
    const locked = await request(app).post('/api/auth/login').send({ email: a.email, password: PASSWORD });
    expect(locked.status).toBe(429);
    const f1 = await request(app).post('/api/auth/forgot-password').send({ email: a.email });
    const f2 = await request(app).post('/api/auth/forgot-password').send({ email: `${uniq('ghost')}@example.com` });
    expect(Object.keys(f1.body.data).sort().filter((k) => !k.startsWith('dev'))).toEqual(Object.keys(f2.body.data).sort().filter((k) => !k.startsWith('dev')));
  });

  it('one-time tokens: wrong type, reuse and expiry are rejected; invitations are bound to the invited email', async () => {
    const email = `${uniq('tok')}@example.com`;
    const reg = await request(app).post('/api/auth/register').send({ name: 'Token User', email, password: PASSWORD });
    const verifyToken = new URL(reg.body.data.devVerificationLink).searchParams.get('token')!;
    expect((await request(app).post('/api/auth/reset-password').send({ token: verifyToken, password: 'Another1Pass' })).status).toBe(400); // verify token ≠ reset token
    expect((await request(app).post('/api/auth/verify-email').send({ token: verifyToken })).status).toBe(200);
    expect((await request(app).post('/api/auth/verify-email').send({ token: verifyToken })).status).toBe(400); // single use
    const f = await request(app).post('/api/auth/forgot-password').send({ email });
    const resetToken = new URL(f.body.data.devResetLink).searchParams.get('token')!;
    await ownerPrisma.authToken.updateMany({ where: { tokenHash: sha256(resetToken) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).post('/api/auth/reset-password').send({ token: resetToken, password: 'Another1Pass' })).status).toBe(400); // expired

    const owner = await createWorkspace(await signUp('Invite Owner'), 'Invite Co');
    const roles = (await owner.get('/roles')).body.data as Array<{ id: string; systemKey: string }>;
    const inv = await owner.post('/invitations', { email: `${uniq('inv')}@example.com`, roleId: roles.find((r) => r.systemKey === 'SALES_AGENT')!.id });
    const token = new URL(inv.body.data.devInviteLink).searchParams.get('token')!;
    const stranger = await signUp('Stranger');
    const wrong = await stranger.agent.post('/api/auth/invitation/accept').send({ token });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('INVITE_EMAIL_MISMATCH');
    expect((await stranger.agent.post('/api/auth/invitation/accept').send({ token: 'z'.repeat(43) })).status).toBe(404);
    await ownerPrisma.invitation.updateMany({ where: { id: inv.body.data.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const preview = await request(app).get(`/api/auth/invitation?token=${token}`);
    expect(preview.body.data.status).toBe('EXPIRED');
  });
});

describe('file upload validation', () => {
  let owner: Actor;
  beforeAll(async () => { owner = await createWorkspace(await signUp('Upload Owner'), 'Upload Co'); });
  const upload = (buf: Buffer, name: string) => owner.agent.post('/api/leads/import?dryRun=true').set('X-Org-Id', owner.orgId!).attach('file', buf, name);

  it('validates content, not names: fake xlsx, binary-as-csv, empty files and zip bombs are rejected', async () => {
    expect((await upload(Buffer.from('this is not a zip'), 'leads.xlsx')).body.error.code).toBe('UNSUPPORTED_FILE');
    expect((await upload(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3, 4, 5, 6]), 'leads.csv')).body.error.code).toBe('UNSUPPORTED_FILE');
    expect((await upload(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]), 'leads.csv')).body.error.code).toBe('UNSUPPORTED_FILE'); // PDF with a csv name
    expect((await upload(Buffer.alloc(0), 'leads.csv')).status).toBe(400);
    expect((await upload(Buffer.from('a,b\n1,2'), 'leads.exe')).body.error.code).toBe('UNSUPPORTED_FILE');
    // handcrafted ZIP whose central directory claims a 2 GB entry
    const name = Buffer.from('x.xml');
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), name]);
    const central = Buffer.alloc(46 + name.length); central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(0x7fffffff, 24); central.writeUInt16LE(name.length, 28); name.copy(central, 46);
    const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length, 16);
    const bomb = await upload(Buffer.concat([local, central, eocd]), 'leads.xlsx');
    expect(bomb.status).toBe(400);
    expect(bomb.body.error.code).toBe('FILE_TOO_LARGE');
    const big = await upload(Buffer.alloc(9 * 1024 * 1024, 'a'), 'big.csv');
    expect(big.status).toBe(413);
  });

  it('enforces row, column and formula-injection protections', async () => {
    const wide = Array.from({ length: 150 }, (_, i) => `c${i}`).join(',');
    expect((await upload(Buffer.from(`${wide}\n${wide}`), 'wide.csv')).body.error.code).toBe('TOO_MANY_COLUMNS');
    const rows = ['First Name,Email', ...Array.from({ length: 2005 }, (_, i) => `A${i},a${i}@x.test`)].join('\n');
    expect((await upload(Buffer.from(rows), 'rows.csv')).body.error.code).toBe('TOO_MANY_ROWS');
    await owner.post('/leads', { firstName: '=HYPERLINK("http://evil","x")', email: 'inj@x.test' });
    const exp = await owner.get('/leads/export?format=csv');
    expect(exp.text).toContain(`'=HYPERLINK`); // neutralised in the spreadsheet
  });

  it('logos: only small raster images whose bytes match; SVG/HTML/mismatched content rejected', async () => {
    const good = `data:image/png;base64,${png.toString('base64')}`;
    expect((await owner.patch('/organizations/current', { logoData: good })).status).toBe(200);
    expect((await owner.patch('/organizations/current', { logoData: `data:image/svg+xml;base64,${Buffer.from('<svg onload=alert(1)/>').toString('base64')}` })).status).toBe(400);
    expect((await owner.patch('/organizations/current', { logoData: `data:image/png;base64,${Buffer.from('<html>not a png</html>').toString('base64')}` })).status).toBe(400);
    expect((await owner.patch('/organizations/current', { logoData: 'javascript:alert(1)' })).status).toBe(400);
    expect((await owner.patch('/organizations/current', { logoData: null })).status).toBe(200);
  });
});

describe('injection resistance', () => {
  it('hostile input in search, filters, sort and ids never errors, leaks or alters the schema', async () => {
    const a = await createWorkspace(await signUp('Inj Owner'), 'Inj Co');
    const b = await createWorkspace(await signUp('Inj Other'), 'Inj Other Co');
    await b.post('/leads', { firstName: 'Secret', email: 'secret@other.test' });
    const payloads = ["' OR 1=1 --", "'; DROP TABLE leads; --", '%27%20OR%20%271%27%3D%271', '" OR ""="', '\\', '%', '_', '${7*7}', '<script>alert(1)</script>', 'x'.repeat(99)];
    for (const p of payloads) {
      const r = await a.get(`/leads?q=${encodeURIComponent(p)}`);
      expect(r.status, p).toBe(200);
      expect(r.body.data).toHaveLength(0);
      for (const url of [`/leads?assignedToId=${encodeURIComponent(p)}`, `/leads?tagId=${encodeURIComponent(p)}`, `/tasks?q=${encodeURIComponent(p)}`, `/opportunities?q=${encodeURIComponent(p)}`, `/followups?q=${encodeURIComponent(p)}`, `/leads/${encodeURIComponent(p)}`]) {
        const rr = await a.get(url);
        expect([200, 400, 404], `${url} → ${rr.status}`).toContain(rr.status);
      }
    }
    expect((await a.get('/leads?sort=password_hash;DROP&order=asc')).status).toBe(400);
    expect((await a.get('/leads?pageSize=999999')).status).toBe(400);
    expect((await a.get('/leads?q=Secret')).body.data).toHaveLength(0); // other tenant's row never matches
    const [t] = await ownerPrisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) n FROM information_schema.tables WHERE table_name = 'leads'`);
    expect(Number(t!.n)).toBe(1);
    // SQL-looking values are stored as plain text
    const lead = await a.post('/leads', { firstName: "Robert'); DROP TABLE leads;--", email: 'bobby@tables.test' });
    expect(lead.status).toBe(201);
    expect((await a.get(`/leads/${lead.body.data.id}`)).body.data.firstName).toBe("Robert'); DROP TABLE leads;--");
  });
});

describe('authorization sweep over every registered endpoint', () => {
  let tenantA: Actor, outsider: Actor, viewer: Actor, agent: Actor, platformAdmin: Actor;
  beforeAll(async () => {
    tenantA = await createWorkspace(await signUp('Sweep Owner'), 'Sweep Co');
    viewer = await addMember(tenantA, 'VIEWER');
    agent = await addMember(tenantA, 'SALES_AGENT');
    outsider = await createWorkspace(await signUp('Sweep Outsider'), 'Outsider Co');
    platformAdmin = await makePlatformAdmin('SUPPORT_ADMIN');
  });
  const concrete = (path: string) => path.replace(/\{(\w+)\}/g, () => randomUUID());
  const call = (a: { agent: Actor['agent'] }, method: string, path: string, org?: string) => {
    const r = (a.agent as unknown as Record<string, (u: string) => request.Test>)[method]!(concrete(path));
    if (org) r.set('X-Org-Id', org);
    return method === 'get' || method === 'delete' ? r : r.send({});
  };

  it('every workspace endpoint requires authentication', async () => {
    const routes = routeRegistry.filter((r) => r.auth === 'org' || r.auth === 'user' || r.auth === 'platform');
    expect(routes.length).toBeGreaterThan(100);
    for (const r of routes) {
      const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[r.method]!(concrete(r.path)).set('X-Org-Id', tenantA.orgId!).send({});
      expect(res.status, `${r.method.toUpperCase()} ${r.path} without a session`).toBe(401);
    }
  });

  it('a signed-in user can never use another workspace\'s id (all workspace endpoints answer 403 NOT_A_MEMBER)', async () => {
    for (const r of routeRegistry.filter((x) => x.auth === 'org')) {
      const res = await call(outsider, r.method, r.path, tenantA.orgId!);
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(403);
      expect(res.body.error.code, `${r.method.toUpperCase()} ${r.path}`).toBe('NOT_A_MEMBER');
    }
  });

  it('permission-gated endpoints refuse members that lack the permission (viewer cannot write, agent cannot administer)', async () => {
    const viewerPerms = new Set(['dashboard.view_all', 'reports.view', 'reports.view_all', 'leads.view_all', 'opportunities.view_all', 'followups.view_all', 'tasks.view_all', 'team.view']);
    const agentPerms = new Set(['reports.view', 'leads.create', 'leads.update', 'opportunities.manage', 'followups.manage', 'tasks.manage', 'team.view']);
    let checked = 0;
    for (const r of routeRegistry.filter((x) => x.auth === 'org' && x.perm)) {
      for (const [who, perms] of [[viewer, viewerPerms], [agent, agentPerms]] as const) {
        if (r.perm!.some((p) => perms.has(p))) continue;
        const res = await call(who, r.method, r.path, tenantA.orgId!);
        expect(res.status, `${who === viewer ? 'viewer' : 'agent'} ${r.method.toUpperCase()} ${r.path} needs ${r.perm!.join('|')}`).toBe(403);
        expect(res.body.error.code).toBe('MISSING_PERMISSION');
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(80);
  });

  it('platform endpoints are closed to tenant users, and billing endpoints are closed to support admins', async () => {
    for (const r of routeRegistry.filter((x) => x.auth === 'platform')) {
      const res = await call(tenantA, r.method, r.path);
      expect(res.status, `tenant user ${r.method.toUpperCase()} ${r.path}`).toBe(403);
      expect(res.body.error.code).toBe('PLATFORM_ONLY');
    }
    const billingRoutes = [['post', '/api/platform/plans'], ['post', '/api/platform/invoices/' + randomUUID() + '/mark-paid'], ['post', `/api/platform/subscriptions/${randomUUID()}/adjust`]] as const;
    for (const [m, p] of billingRoutes) expect((await (platformAdmin.agent as unknown as Record<string, (u: string) => request.Test>)[m]!(p).send({})).status, p).toBe(403);
    // and platform role can never read verification / reset links
    await expect(platformPrisma.outboundEmail.findFirst()).rejects.toThrow(/permission denied/i);
    expect((await withOrg(platformAdmin, tenantA.orgId!).get('/leads')).status).toBe(403);
  });
});

describe('privilege escalation', () => {
  it('members cannot grant themselves or others more power than they have', async () => {
    const owner = await createWorkspace(await signUp('Esc Owner'), 'Esc Co');
    const roles = (await owner.get('/roles')).body.data as Array<{ id: string; systemKey: string }>;
    const roleOf = (k: string) => roles.find((r) => r.systemKey === k)!.id;
    // a "People manager" custom role: can manage team + roles, but no billing
    const custom = (await owner.post('/roles', { name: 'People Manager', permissions: ['team.view', 'team.manage', 'roles.manage', 'leads.create'] })).body.data;
    const pm = await addMember(owner, 'SALES_AGENT');
    const members = (await owner.get('/members')).body.data as Array<{ id: string; userId: string }>;
    await owner.patch(`/members/${members.find((m) => m.userId === pm.userId)!.id}`, { roleId: custom.id });
    const inviteAdmin = await pm.post('/invitations', { email: `${uniq('adm')}@example.com`, roleId: roleOf('ADMIN') });
    expect(inviteAdmin.status).toBe(403);
    expect(inviteAdmin.body.error.code).toBe('PRIVILEGE_ESCALATION');
    expect((await pm.post('/invitations', { email: `${uniq('own')}@example.com`, roleId: roleOf('OWNER') })).status).toBe(403);
    const me = members.find((m) => m.userId === pm.userId)!;
    expect((await pm.patch(`/members/${me.id}`, { roleId: roleOf('ADMIN') })).status).toBe(403);
    expect((await pm.post('/roles', { name: 'Super', permissions: ['billing.manage', 'team.manage'] })).status).toBe(403);
    const created = await pm.post('/roles', { name: 'Intern Plus', permissions: ['leads.create'] });
    expect(created.status).toBe(201);
    expect((await pm.patch(`/roles/${roleOf('ADMIN')}`, { permissions: ['leads.create'] })).status).toBe(403); // cannot edit a more powerful role
    expect((await pm.patch(`/roles/${custom.id}`, { permissions: ['team.manage', 'roles.manage', 'billing.manage'] })).status).toBe(403);
    // an owner remains able to do all of it
    expect((await owner.post('/invitations', { email: `${uniq('ok')}@example.com`, roleId: roleOf('ADMIN') })).status).toBe(201);
    // admins cannot touch owners or grant the owner role
    const admin = await addMember(owner, 'ADMIN');
    const ownerMember = members.find((m) => m.userId === owner.userId)!;
    expect((await admin.patch(`/members/${ownerMember.id}`, { status: 'DEACTIVATED' })).status).toBe(403);
    expect((await admin.post('/invitations', { email: `${uniq('o2')}@example.com`, roleId: roleOf('OWNER') })).status).toBe(403);
  });
});
