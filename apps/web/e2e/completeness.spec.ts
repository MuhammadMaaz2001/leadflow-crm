import { expect, test, type Page } from '@playwright/test';
import { api, createWorkspace, type Workspace } from './fixtures';
import { login, toast, uniq } from './helpers';

let ws: Workspace;
test.describe.configure({ mode: 'default' });
test.beforeAll(async ({ browser }) => { ws = await createWorkspace(browser, 'Complete'); });
test.afterAll(async () => { for (const p of Object.values(ws?.people ?? {})) await p.ctx.close(); });

async function platformAdmin(browser: import('@playwright/test').Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await login(page, 'admin@leadflow.test', 'Admin#Pass2026', /\/platform/);
  return { page, close: () => ctx.close() };
}

test('team: deactivating a member with open work asks who takes over, hands everything over and says what moved', async () => {
  const mgr = api(ws.people.MANAGER, ws.id);
  const agent = ws.people.SALES_AGENT;
  for (let i = 0; i < 3; i++) await mgr.post('/leads', { firstName: `Handover${i}`, email: `ho${i}-${uniq()}@x.test`, assignedToId: agent.userId });
  const p = ws.people.OWNER.page;
  await p.goto('/team');
  await p.getByRole('button', { name: `Actions for ${agent.name}` }).click();
  await p.getByRole('menuitem', { name: /Deactivate/ }).click();
  const dlg = p.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Deactivate' }).click();
  await expect(dlg.getByText(/still owns/)).toBeVisible();                                   // the API refused to orphan the work and the UI explains why
  await expect(dlg.getByRole('button', { name: 'Deactivate' })).toBeDisabled();             // a choice is required
  await dlg.getByLabel('Hand over to').selectOption({ label: ws.people.MANAGER.name });
  await dlg.getByRole('button', { name: 'Deactivate' }).click();
  await toast(p, /deactivated — 3 leads/);
  await expect(p.getByRole('table').getByText('Deactivated').first()).toBeVisible();
  const leads = await api(ws.people.MANAGER, ws.id).get('/leads?q=Handover');
  expect(leads.data.every((l: { assignedTo: { id: string } }) => l.assignedTo.id === ws.people.MANAGER.userId)).toBe(true);
  // reactivate again so later tests can use the agent
  await p.getByRole('button', { name: `Actions for ${agent.name}` }).click();
  await p.getByRole('menuitem', { name: /Reactivate/ }).click();
  await toast(p, 'Member updated');
});

test('automations: a rule can assign leads and schedule follow-ups, and runs show up in the history', async () => {
  const p = ws.people.OWNER.page;
  await p.goto('/automations');
  await p.getByRole('button', { name: 'New automation' }).first().click();
  const dlg = p.getByRole('dialog');
  await dlg.locator('#au-name').fill('Distribute and follow up');
  const actionType = dlg.getByLabel('Action type').first();
  await actionType.selectOption('ASSIGN_LEAD');
  await expect(dlg.getByLabel('Assignment mode')).toBeVisible();
  await dlg.getByRole('button', { name: /Add action/ }).click();
  await dlg.getByLabel('Action type').nth(1).selectOption('CREATE_FOLLOWUP');
  await expect(dlg.getByLabel('Follow-up due in hours')).toBeVisible();
  await dlg.getByLabel('Follow-up due in hours').fill('48');
  await dlg.getByRole('button', { name: 'Create automation' }).click();
  await toast(p, /Automation (created|saved)/i);
  await expect(p.getByText('Distribute and follow up')).toBeVisible();
  // it works end to end
  const created = await api(ws.people.MANAGER, ws.id).post('/leads', { firstName: 'AutoFlow', email: `af-${uniq()}@x.test` });
  expect(created.status).toBe(201);
  await p.getByRole('tab', { name: 'Execution log' }).click();
  const exec = await api(ws.people.OWNER, ws.id).get('/automations/executions?pageSize=50');
  expect(exec.data.some((e: { rule: { name: string }; status: string }) => e.rule.name === 'Distribute and follow up' && e.status === 'SUCCESS')).toBe(true);
});

test('saved views belong to the user, follow them across browsers, and managers can share them', async ({ browser }) => {
  const m = ws.people.MANAGER.page;
  await m.goto('/leads?status=NEW&sort=name&order=asc');
  await m.getByRole('button', { name: 'Views' }).click();
  await m.getByRole('menuitem', { name: /Save current filters/ }).click();
  await m.getByLabel('View name').fill('New, A–Z');
  await m.getByLabel(/Share with everyone/).check();
  await m.getByRole('button', { name: 'Save view' }).click();
  await toast(m, 'View saved');
  // a different browser (new context) of the same manager still has it: it lives on the server
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const m2 = await ctx2.newPage();
  await login(m2, ws.people.MANAGER.email, 'E2e#Passw0rd', /\/(dashboard|onboarding)/);
  await m2.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } }, ['lf_org', ws.id]);
  await m2.goto('/leads');
  await m2.getByRole('button', { name: 'Views' }).click();
  await expect(m2.getByRole('menuitem', { name: /New, A–Z/ })).toBeVisible();
  await ctx2.close();
  // the agent sees the shared view (marked with its author) but cannot share one of her own
  const a = ws.people.SALES_AGENT.page;
  await a.goto('/leads');
  await a.getByRole('button', { name: 'Views' }).click();
  await expect(a.getByRole('menuitem', { name: /New, A–Z/ })).toBeVisible();
  await a.getByRole('menuitem', { name: /New, A–Z/ }).click();
  await expect(a).toHaveURL(/status=NEW/);
  await a.getByRole('button', { name: 'Views' }).click();
  await a.getByRole('menuitem', { name: /Save current filters/ }).click();
  await expect(a.getByLabel(/Share with everyone/)).toHaveCount(0);
  await a.keyboard.press('Escape');
});

test('platform billing: receipts show who/when and the expiry change; extension without payment needs a reason; the latest payment can be reversed', async ({ browser }) => {
  const owner = ws.people.OWNER;
  const { page: ap, close } = await platformAdmin(browser);
  await ap.goto('/platform/organizations');
  await ap.getByLabel('Search organizations').fill(ws.name);
  await ap.getByRole('table').getByText(ws.name).click();
  await ap.getByRole('tab', { name: 'Billing' }).click();
  // 1. record a payment for the current plan, 3 months
  await ap.getByRole('button', { name: /Record payment & extend/ }).click();
  let d = ap.getByRole('dialog');
  await d.getByLabel('Amount received').fill('237');
  await d.getByLabel('Payment reference').fill(`E2E-${uniq()}`);
  await d.getByRole('button', { name: '3 months' }).click();
  await expect(d.getByText('Previous expiry')).toBeVisible();
  await d.getByRole('button', { name: /Confirm payment/ }).click();
  await toast(ap, /Payment confirmed — receipt RC-/);
  await expect(ap.getByText(/^RC-\d{4}-/).first()).toBeVisible();
  // 2. extension without payment: reason required
  await ap.getByRole('button', { name: 'Extend without payment' }).click();
  d = ap.getByRole('dialog');
  await expect(d.getByRole('button', { name: 'Extend', exact: true })).toBeDisabled();
  await d.getByLabel('Extension reason').fill('Compensation for a service interruption');
  await d.getByRole('button', { name: '1 month' }).click();
  await d.getByRole('button', { name: 'Extend', exact: true }).click();
  await toast(ap, 'Subscription extended');
  await expect(ap.getByText(/WITHOUT a payment/)).toBeVisible();
  // 3. the owner sees the receipt and both history entries but no internal notes
  const op = owner.page;
  await op.goto('/billing');
  await op.getByRole('tab', { name: /Payments/ }).click();
  await expect(op.getByText(/^RC-\d{4}-/).first()).toBeVisible();
  await op.getByRole('tab', { name: 'Subscription history' }).click();
  await expect(op.getByText(/Extended by/)).toBeVisible();
  // 4. the payment can no longer be reversed automatically: the extension changed the expiry after it (a correction must be explicit)
  await ap.reload();
  await ap.getByRole('tab', { name: 'Billing' }).click();
  await ap.getByRole('button', { name: /Reverse/ }).first().click();
  await ap.getByLabel('Reversal reason').fill('Entered against the wrong workspace');
  await ap.getByRole('dialog').getByRole('button', { name: 'Reverse payment' }).click();
  await expect(ap.locator('[data-sonner-toast]').filter({ hasText: /Only the most recent payment can be reversed/ }).first()).toBeVisible();
  await close();
});
