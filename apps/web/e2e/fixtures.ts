import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { API, PASSWORD, uniq } from './helpers';

export type RoleKey = 'OWNER' | 'ADMIN' | 'MANAGER' | 'SALES_AGENT' | 'VIEWER';
export interface Person { name: string; email: string; ctx: BrowserContext; page: Page; userId: string }
export interface Workspace { id: string; name: string; people: Record<RoleKey, Person>; roles: Record<string, string> }

async function makeUser(browser: Browser, name: string, email: string): Promise<{ ctx: BrowserContext; page: Page; userId: string }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const reg = await ctx.request.post(`${API}/api/auth/register`, { data: { name, email, password: PASSWORD } });
  const body = await reg.json();
  if (body.data.verificationRequired) await ctx.request.post(`${API}/api/auth/verify-email`, { data: { token: new URL(body.data.devVerificationLink).searchParams.get('token') } });
  const login = await ctx.request.post(`${API}/api/auth/login`, { data: { email, password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const me = await (await ctx.request.get(`${API}/api/auth/me`)).json();
  return { ctx, page: await ctx.newPage(), userId: me.data.user.id };
}

/** Creates a workspace with one member per role, entirely through the API (UI tests then exercise the screens). */
export async function createWorkspace(browser: Browser, label = 'Fixture'): Promise<Workspace> {
  const id = uniq();
  const name = `${label} ${id}`;
  const owner = await makeUser(browser, 'Olivia Owner', `owner-${id}@fx.test`);
  const org = await (await owner.ctx.request.post(`${API}/api/organizations`, { data: { name, industry: 'Consulting' } })).json();
  const orgId = org.data.id as string;
  const H = { 'X-Org-Id': orgId };
  await owner.ctx.request.post(`${API}/api/organizations/current/onboarding`, { headers: H, data: { complete: true } });
  const roles = Object.fromEntries(((await (await owner.ctx.request.get(`${API}/api/roles`, { headers: H })).json()).data as Array<{ id: string; systemKey: string }>).map((r) => [r.systemKey, r.id]));
  const people: Partial<Record<RoleKey, Person>> = { OWNER: { name: 'Olivia Owner', email: `owner-${id}@fx.test`, ctx: owner.ctx, page: owner.page, userId: owner.userId } };
  for (const [key, display] of [['ADMIN', 'Adam Admin'], ['MANAGER', 'Mark Manager'], ['SALES_AGENT', 'Sam Agent'], ['VIEWER', 'Vera Viewer']] as const) {
    const email = `${key.toLowerCase()}-${id}@fx.test`;
    const inv = await (await owner.ctx.request.post(`${API}/api/invitations`, { headers: H, data: { email, roleId: roles[key] } })).json();
    const u = await makeUser(browser, display, email);
    const acc = await u.ctx.request.post(`${API}/api/auth/invitation/accept`, { data: { token: new URL(inv.data.devInviteLink).searchParams.get('token') } });
    expect(acc.ok(), `${key} accepts invite`).toBeTruthy();
    people[key] = { name: display, email, ctx: u.ctx, page: u.page, userId: u.userId };
  }
  for (const p of Object.values(people)) await p!.ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } }, ['lf_org', orgId]);
  return { id: orgId, name, people: people as Record<RoleKey, Person>, roles };
}

export const api = (p: Person, orgId: string) => ({
  get: async (path: string) => (await p.ctx.request.get(`${API}/api${path}`, { headers: { 'X-Org-Id': orgId } })).json(),
  post: async (path: string, data: object = {}) => { const r = await p.ctx.request.post(`${API}/api${path}`, { headers: { 'X-Org-Id': orgId }, data }); return { status: r.status(), body: await r.json().catch(() => null) }; },
  patch: async (path: string, data: object = {}) => { const r = await p.ctx.request.patch(`${API}/api${path}`, { headers: { 'X-Org-Id': orgId }, data }); return { status: r.status(), body: await r.json().catch(() => null) }; },
});
