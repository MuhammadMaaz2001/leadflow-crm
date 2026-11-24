import { beforeAll, describe, expect, it } from 'vitest';
import { app, boot, createWorkspace, PASSWORD, request, signUp, uniq } from './helpers';

beforeAll(boot);

describe('authentication & workspace onboarding', () => {
  it('registers, requires email verification, then signs in', async () => {
    const email = `${uniq('reg')}@example.com`;
    const agent = request.agent(app);
    const reg = await agent.post('/api/auth/register').send({ name: 'Ada Lovelace', email, password: PASSWORD });
    expect(reg.status).toBe(201);
    expect(reg.body.data.devVerificationLink).toContain('/verify-email?token=');

    const early = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const token = new URL(reg.body.data.devVerificationLink).searchParams.get('token');
    expect((await agent.post('/api/auth/verify-email').send({ token })).status).toBe(200);
    expect((await agent.post('/api/auth/verify-email').send({ token })).status).toBe(400); // single use

    expect((await agent.post('/api/auth/login').send({ email, password: 'wrong-pass1' })).status).toBe(401);
    expect((await agent.post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
    const me = await agent.get('/api/auth/me');
    expect(me.body.data.user.email).toBe(email);
    expect(me.body.data.workspaces).toEqual([]);
  });

  it('rejects weak passwords and duplicate emails', async () => {
    const r = await request(app).post('/api/auth/register').send({ name: 'X Y', email: `${uniq('w')}@example.com`, password: 'short' });
    expect(r.status).toBe(400);
    expect(r.body.error.details.fields.password).toBeTruthy();
    const a = await signUp();
    const dup = await request(app).post('/api/auth/register').send({ name: 'Dup', email: a.email, password: PASSWORD });
    expect(dup.status).toBe(409);
  });

  it('supports password reset which revokes old sessions', async () => {
    const a = await signUp();
    const f = await request(app).post('/api/auth/forgot-password').send({ email: a.email });
    const token = new URL(f.body.data.devResetLink).searchParams.get('token');
    const r = await request(app).post('/api/auth/reset-password').send({ token, password: 'NewPassw0rd!' });
    expect(r.status).toBe(200);
    expect((await a.agent.get('/api/auth/me')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: a.email, password: 'NewPassw0rd!' })).status).toBe(200);
  });

  it('creates a workspace with default roles, pipeline and a trial subscription', async () => {
    const a = await signUp();
    const w = await createWorkspace(a, 'Acme Realty');
    const cur = await w.get('/organizations/current');
    expect(cur.status).toBe(200);
    expect(cur.body.data.subscription.status).toBe('TRIALING');
    expect(cur.body.data.role.key).toBe('OWNER');
    const roles = await w.get('/roles');
    expect(roles.body.data.map((r: { systemKey: string }) => r.systemKey).sort()).toEqual(['ADMIN', 'MANAGER', 'OWNER', 'SALES_AGENT', 'VIEWER']);
    const me = await a.agent.get('/api/auth/me');
    expect(me.body.data.workspaces).toHaveLength(1);
  });

  it('requires authentication on protected routes', async () => {
    expect((await request(app).get('/api/organizations/current')).status).toBe(401);
  });
});
