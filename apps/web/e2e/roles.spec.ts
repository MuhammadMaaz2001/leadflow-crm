import { expect, test } from '@playwright/test';
import { api, createWorkspace, type RoleKey, type Workspace } from './fixtures';
import { API, PASSWORD, uniq } from './helpers';

let ws: Workspace;
test.beforeAll(async ({ browser }) => { ws = await createWorkspace(browser, 'Roles'); });
test.afterAll(async () => { for (const p of Object.values(ws?.people ?? {})) await p.ctx.close(); });

const NAV = ['Dashboard', 'Leads', 'Sales Pipeline', 'Opportunities', 'Follow-ups', 'Tasks & Calendar', 'Team Members', 'Reports & Analytics', 'Activity Logs', 'Automations', 'Subscription & Billing', 'Workspace Settings'];
const EXPECT: Record<RoleKey, { nav: string[]; addLead: boolean; importBtn: boolean; invite: boolean; newOpp: boolean }> = {
  OWNER: { nav: NAV, addLead: true, importBtn: true, invite: true, newOpp: true },
  ADMIN: { nav: NAV, addLead: true, importBtn: true, invite: true, newOpp: true },
  MANAGER: { nav: NAV.filter((n) => !['Subscription & Billing', 'Workspace Settings'].includes(n)), addLead: true, importBtn: true, invite: false, newOpp: true },
  SALES_AGENT: { nav: NAV.filter((n) => !['Automations', 'Subscription & Billing', 'Workspace Settings'].includes(n)), addLead: true, importBtn: false, invite: false, newOpp: true },
  VIEWER: { nav: NAV.filter((n) => !['Automations', 'Subscription & Billing', 'Workspace Settings'].includes(n)), addLead: false, importBtn: false, invite: false, newOpp: false },
};

for (const role of Object.keys(EXPECT) as RoleKey[]) {
  test(`${role}: sees exactly the navigation and actions its role allows`, async () => {
    const p = ws.people[role].page;
    const want = EXPECT[role];
    await p.goto('/dashboard');
    const nav = p.getByRole('navigation', { name: 'Main' });
    for (const item of NAV) {
      if (want.nav.includes(item)) await expect(nav.getByRole('link', { name: item, exact: true }), `${role} sees ${item}`).toBeVisible();
      else await expect(nav.getByRole('link', { name: item, exact: true }), `${role} must not see ${item}`).toHaveCount(0);
    }
    await p.goto('/leads');
    await expect(p.getByRole('heading', { name: 'Leads' })).toBeVisible();
    await expect(p.getByRole('button', { name: 'Add lead' }).first()).toBeVisible({ visible: want.addLead });
    await expect(p.getByRole('button', { name: 'Import' }).first()).toBeVisible({ visible: want.importBtn });
    await p.goto('/team');
    await expect(p.getByRole('button', { name: 'Invite member' }).first()).toBeVisible({ visible: want.invite });
    await p.goto('/pipeline');
    await expect(p.getByRole('button', { name: 'New opportunity' }).first()).toBeVisible({ visible: want.newOpp });
    // direct URL access to a forbidden page shows a clear message instead of a broken screen
    for (const [path, needsLabel] of [['/billing', 'Subscription & Billing'], ['/settings', 'Workspace Settings'], ['/automations', 'Automations']] as const) {
      await p.goto(path);
      if (want.nav.includes(needsLabel)) await expect(p.getByText("You don't have access to this page")).toHaveCount(0);
      else await expect(p.getByText("You don't have access to this page")).toBeVisible();
    }
  });
}

test('data visibility: agents see only their own leads, managers and viewers see everything', async () => {
  const mgr = api(ws.people.MANAGER, ws.id);
  const a = await mgr.post('/leads', { firstName: 'Alice', email: `alice-${uniq()}@v.test`, assignedToId: ws.people.SALES_AGENT.userId });
  const b = await mgr.post('/leads', { firstName: 'Bruno', email: `bruno-${uniq()}@v.test`, assignedToId: ws.people.MANAGER.userId });
  expect(a.status).toBe(201); expect(b.status).toBe(201);
  const check = async (role: RoleKey, expectBruno: boolean) => {
    const p = ws.people[role].page;
    await p.goto('/leads');
    await expect(p.getByRole('table').getByText('Alice', { exact: true })).toBeVisible();
    await expect(p.getByRole('table').getByText('Bruno', { exact: true })).toHaveCount(expectBruno ? 1 : 0);
    await p.goto(`/leads/${b.body.data.id}`);
    if (expectBruno) await expect(p.getByRole('heading', { name: /Bruno/ })).toBeVisible();
    else await expect(p.getByText('Lead not found')).toBeVisible();
  };
  await check('SALES_AGENT', false);
  await check('MANAGER', true);
  await check('VIEWER', true);
  await check('ADMIN', true);
  // dashboards
  await ws.people.SALES_AGENT.page.goto('/dashboard');
  await expect(ws.people.SALES_AGENT.page.getByText('Showing your own leads and follow-ups.')).toBeVisible();
  await ws.people.MANAGER.page.goto('/dashboard');
  await expect(ws.people.MANAGER.page.getByText('Company-wide performance')).toBeVisible();
});

test('workspace switching: one user, two workspaces, separate roles and data', async ({ browser }) => {
  // fresh context: the shared fixture pins the first workspace on every page load, which would mask real switching
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const login = await ctx.request.post(`${API}/api/auth/login`, { data: { email: ws.people.OWNER.email, password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const seeded = await api(ws.people.OWNER, ws.id).post('/leads', { firstName: 'Alice', email: `alice-sw-${uniq()}@v.test` });
  expect(seeded.status).toBe(201);
  const secondName = `Second Co ${uniq()}`;
  const other = await ctx.request.post(`${API}/api/organizations`, { data: { name: secondName, industry: 'Consulting' } });
  expect(other.status()).toBe(201);
  const secondId = (await other.json()).data.id as string;
  await ctx.request.post(`${API}/api/organizations/current/onboarding`, { headers: { 'X-Org-Id': secondId }, data: { complete: true } });
  await p.addInitScript((id) => { try { if (!localStorage.getItem('lf_org')) localStorage.setItem('lf_org', id); } catch { /* ignore */ } }, ws.id);
  await p.goto('/leads');
  await expect(p.getByRole('table').getByText('Alice', { exact: true }).first()).toBeVisible();
  await p.getByRole('button', { name: 'Switch workspace' }).click();
  await expect(p.getByRole('menuitem')).toHaveCount(3); // two workspaces + "Create workspace"
  await p.getByRole('menuitem', { name: new RegExp(secondName) }).click();
  await expect(p.getByRole('button', { name: 'Switch workspace' })).toContainText(secondName);
  await p.goto('/leads');                                              // the choice survives a full reload
  await expect(p.getByRole('button', { name: 'Switch workspace' })).toContainText(secondName);
  await expect(p.getByText('Alice', { exact: true })).toHaveCount(0);   // the first workspace's leads do not leak across
  await p.goto('/team');
  await expect(p.getByRole('table').getByText('Olivia Owner')).toBeVisible();
  await expect(p.getByText('Mark Manager')).toHaveCount(0);
  await p.getByRole('button', { name: 'Switch workspace' }).click();
  await p.getByRole('menuitem', { name: new RegExp(ws.name) }).click();
  await p.goto('/team');
  await expect(p.getByRole('table').getByText('Mark Manager')).toBeVisible();
  const first = await api(ws.people.OWNER, ws.id).get('/leads');
  const second = await api(ws.people.OWNER, secondId).get('/leads');
  expect(first.meta.total).toBeGreaterThan(0);
  expect(second.meta.total).toBe(0);
  await ctx.close();
});

test.describe('platform administrator roles', () => {
  const login = async (browser: import('@playwright/test').Browser, email: string) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await p.goto('/login');
    await p.locator('#email').fill(email); await p.locator('#password').fill('Admin#Pass2026');
    await p.getByRole('button', { name: 'Sign in' }).click();
    await p.waitForURL(/\/platform/);
    return { ctx, p };
  };
  test('support admin can suspend but not edit plans; super admin can do both; platform area is separate from the workspace shell', async ({ browser }) => {
    const sup = await login(browser, 'support@leadflow.test');
    await sup.p.goto('/platform/plans');
    await expect(sup.p.getByRole('button', { name: 'New plan' })).toHaveCount(0);
    await sup.p.goto('/platform/organizations');
    await sup.p.getByLabel('Search organizations').fill(ws.name);
    await sup.p.getByRole('table').getByText(ws.name).click();
    await expect(sup.p.getByRole('button', { name: 'Suspend' })).toBeEnabled();
    await expect(sup.p.getByRole('button', { name: 'Adjust subscription' })).toBeDisabled();
    // the platform shell has its own navigation and no tenant data
    await expect(sup.p.getByRole('navigation', { name: 'Platform' })).toBeVisible();
    await expect(sup.p.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expect(sup.p.getByText('Alice')).toHaveCount(0);
    await sup.ctx.close();
    const su = await login(browser, 'admin@leadflow.test');
    await su.p.goto('/platform/plans');
    await expect(su.p.getByRole('button', { name: 'New plan' })).toBeVisible();
    await su.p.goto('/platform/users');
    await expect(su.p.getByLabel(/Platform role for/).locator('visible=true').first()).toBeVisible();
    await su.ctx.close();
    // tenant users are bounced out of /platform
    await ws.people.OWNER.page.goto('/platform');
    await expect(ws.people.OWNER.page).toHaveURL(/\/dashboard/);
  });
});

test('kanban: a deal can be dropped on the pinned Won dock even when the Won column is off-screen', async () => {
  const p = ws.people.MANAGER.page;
  const lead = await api(ws.people.MANAGER, ws.id).post('/leads', { firstName: 'Dock', email: `dock-${uniq()}@v.test` });
  const name = `Dock deal ${uniq()}`;
  const opp = await api(ws.people.MANAGER, ws.id).post('/opportunities', { leadId: lead.body.data.id, name, value: 1200 });
  expect(opp.status).toBe(201);
  await p.goto('/pipeline');
  const card = p.locator('section[aria-label$=" stage"]').getByRole('button', { name: new RegExp(name) }).first();
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 12, { steps: 4 });
  const dock = p.getByTestId('dock-won');
  await expect(dock).toBeVisible();
  const d = (await dock.boundingBox())!;
  await p.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 25 });
  await p.mouse.up();
  await expect(p.locator('[data-sonner-toast]').filter({ hasText: /won/i }).first()).toBeVisible();
  const after = await api(ws.people.MANAGER, ws.id).get(`/opportunities/${opp.body.data.id}`);
  expect(after.data.status).toBe('WON');
});
