import request from 'supertest';
import { createApp } from '../src/app';
import { ensurePlans } from '../src/modules/subscriptions/service';
import { platformPrisma, prisma } from '../src/db';
import { hashPassword } from '../src/lib/crypto';
import { registerProcessors } from '../src/jobs';

export const app = createApp();
let counter = 0;
export const uniq = (p = 'u') => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;
export const PASSWORD = 'Passw0rd!test';

export async function boot() {
  await ensurePlans();
  registerProcessors();
}

export interface Actor {
  agent: ReturnType<typeof request.agent>;
  email: string;
  userId: string;
  orgId?: string;
  /** Tenant request builders (always send X-Org-Id) */
  get: (url: string) => request.Test;
  post: (url: string, body?: object) => request.Test;
  patch: (url: string, body?: object) => request.Test;
  del: (url: string) => request.Test;
}

function makeActor(agent: ReturnType<typeof request.agent>, email: string, userId: string, orgId?: string): Actor {
  const h = (t: request.Test) => (orgId ? t.set('X-Org-Id', orgId) : t);
  const a: Actor = {
    agent, email, userId, orgId,
    get: (u) => h(agent.get(`/api${u}`)),
    post: (u, b) => h(agent.post(`/api${u}`).send(b ?? {})),
    patch: (u, b) => h(agent.patch(`/api${u}`).send(b ?? {})),
    del: (u) => h(agent.delete(`/api${u}`)),
  };
  return a;
}
export const withOrg = (a: Actor, orgId: string) => makeActor(a.agent, a.email, a.userId, orgId);

/** Registers, verifies (via the dev verification link) and signs in a user. */
export async function signUp(name = 'Test User', email = `${uniq('user')}@example.com`): Promise<Actor> {
  const agent = request.agent(app);
  const reg = await agent.post('/api/auth/register').send({ name, email, password: PASSWORD });
  if (reg.status !== 201) throw new Error(`register failed ${reg.status} ${JSON.stringify(reg.body)}`);
  if (reg.body.data.verificationRequired) {
    const token = new URL(reg.body.data.devVerificationLink).searchParams.get('token');
    const v = await agent.post('/api/auth/verify-email').send({ token });
    if (v.status !== 200) throw new Error('verify failed');
  }
  const login = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed ${login.status} ${JSON.stringify(login.body)}`);
  return makeActor(agent, email, reg.body.data.id);
}

export async function createWorkspace(a: Actor, name = `Company ${uniq('c')}`): Promise<Actor> {
  const r = await a.post('/organizations', { name, industry: 'Consulting' });
  if (r.status !== 201) throw new Error(`org failed ${r.status} ${JSON.stringify(r.body)}`);
  return withOrg(a, r.body.data.id);
}

/** Owner creates a workspace, invites a user with the given system role key and the user accepts. */
export async function addMember(owner: Actor, roleKey: 'ADMIN' | 'MANAGER' | 'SALES_AGENT' | 'VIEWER', name = roleKey): Promise<Actor> {
  const roles = (await owner.get('/roles')).body.data as Array<{ id: string; systemKey: string }>;
  const role = roles.find((r) => r.systemKey === roleKey)!;
  const email = `${uniq(roleKey.toLowerCase())}@example.com`;
  const inv = await owner.post('/invitations', { email, roleId: role.id });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status} ${JSON.stringify(inv.body)}`);
  const token = new URL(inv.body.data.devInviteLink).searchParams.get('token')!;
  const user = await signUp(name, email);
  const acc = await user.agent.post('/api/auth/invitation/accept').send({ token });
  if (acc.status !== 200) throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
  return withOrg(user, owner.orgId!);
}

export async function makePlatformAdmin(role: 'SUPER_ADMIN' | 'SUPPORT_ADMIN' | 'BILLING_ADMIN' = 'SUPER_ADMIN'): Promise<Actor> {
  const email = `${uniq('admin')}@example.com`;
  const agent = request.agent(app);
  await platformPrisma.user.create({ data: { email, name: 'Platform Admin', passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date(), platformRole: role } });
  const login = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  if (login.status !== 200) throw new Error('admin login failed');
  const u = await platformPrisma.user.findUniqueOrThrow({ where: { email } });
  return makeActor(agent, email, u.id);
}

export { request, prisma, platformPrisma };
