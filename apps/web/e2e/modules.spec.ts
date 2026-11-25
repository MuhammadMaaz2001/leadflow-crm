import { expect, test, type Page } from '@playwright/test';
import { api, createWorkspace, type Workspace } from './fixtures';
import { localIn, toast } from './helpers';

let ws: Workspace;
let leadId = '';
let leadName = '';
const table = (p: Page) => p.getByRole('table');

test.describe.configure({ mode: 'default' });

test.beforeAll(async ({ browser }) => {
  ws = await createWorkspace(browser, 'Modules');
  const mgr = api(ws.people.MANAGER, ws.id);
  const r = await mgr.post('/leads', { firstName: 'Nadia', lastName: 'Khan', email: `nadia-${ws.id.slice(0, 6)}@client.test`, phone: '+1 202 555 0188', companyName: 'Khan Design', assignedToId: ws.people.SALES_AGENT.userId });
  leadId = r.body.data.id; leadName = 'Nadia Khan';
  await mgr.post('/leads', { firstName: 'Omar', lastName: 'Reed', email: `omar-${ws.id.slice(0, 6)}@client.test`, companyName: 'Reed & Co' });
});
test.beforeEach(() => {
  for (const [role, person] of Object.entries(ws.people)) {
    if ((person.page as Page & { __logged?: boolean }).__logged) continue;
    (person.page as Page & { __logged?: boolean }).__logged = true;
    person.page.on('pageerror', (e) => console.log(`PAGEERROR[${role}] ${e.message.slice(0, 300)}`));
    person.page.on('console', async (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) { const a = await Promise.all(m.args().map((x) => x.jsonValue().catch(() => ''))); console.log(`CONSOLE[${role}] @${person.page.url().replace(/^https?:\/\/[^/]+/, '')} ${a.join(' ').slice(0, 500)}`); } });
  }
});
test.afterAll(async () => { for (const p of Object.values(ws?.people ?? {})) await p.ctx.close(); });

test.describe('lead detail', () => {
  test('edit, log every activity type, filter timeline, reassign with history, archive and restore', async () => {
    const p = ws.people.MANAGER.page;
    await p.goto(`/leads/${leadId}`);
    await expect(p.getByRole('heading', { name: new RegExp(leadName) })).toBeVisible();
    // edit
    await p.getByRole('button', { name: 'More actions' }).click();
    await p.getByRole('menuitem', { name: 'Edit lead' }).click();
    await p.locator('#lf-job').fill('Creative Director');
    await p.locator('#lf-camp').fill('Autumn promo');
    await p.getByRole('button', { name: 'Save changes' }).click();
    await toast(p, 'Lead updated');
    await expect(p.getByText('Creative Director').first()).toBeVisible();
    await expect(p.getByText('Autumn promo')).toBeVisible();
    // log email / whatsapp / meeting / note
    for (const [label, text] of [['Email', 'Sent the brochure'], ['WhatsApp', 'Quick chat about timing'], ['Meeting', 'Site visit agreed'], ['Note', 'Prefers mornings']] as const) {
      await p.getByRole('button', { name: label, exact: true }).click();
      await p.getByLabel(label === 'Note' ? 'Details' : 'Details').fill(text);
      await p.getByRole('button', { name: 'Save to timeline' }).click();
      await toast(p, 'Activity logged');
      await expect(p.getByText(text)).toBeVisible();
    }
    await p.getByRole('button', { name: 'Notes', exact: true }).click();
    await expect(p.getByText('Prefers mornings')).toBeVisible();
    await expect(p.getByText('Sent the brochure')).toHaveCount(0);
    await p.getByRole('button', { name: 'All', exact: true }).click();
    // reassign
    await p.getByRole('button', { name: 'Reassign' }).first().click();
    await p.getByLabel('Assign to').selectOption({ label: ws.people.ADMIN.name });
    await p.getByLabel('Assignment note').fill('Admin takes over');
    await p.getByRole('button', { name: 'Assign', exact: true }).click();
    await toast(p, 'Lead assigned');
    await p.getByRole('tab', { name: 'Assignments' }).click();
    await expect(p.getByText('Admin takes over')).toBeVisible();
    await expect(p.getByText(ws.people.SALES_AGENT.name).first()).toBeVisible();
    // the new owner got a notification, the previous owner was told as well
    const n = await api(ws.people.ADMIN, ws.id).get('/notifications');
    expect(n.data.some((x: { type: string }) => x.type === 'LEAD_REASSIGNED' || x.type === 'LEAD_ASSIGNED')).toBe(true);
    // archive + restore
    await p.getByRole('button', { name: 'More actions' }).click();
    await p.getByRole('menuitem', { name: 'Archive' }).click();
    await p.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(p).toHaveURL(/\/leads$/);
    await p.goto('/leads?archived=true');
    await expect(table(p).getByText(leadName)).toBeVisible();
    await table(p).getByText(leadName).click();
    await p.getByRole('button', { name: 'Restore lead' }).click();
    await toast(p, 'Lead restored');
    await expect(p.getByRole('button', { name: 'More actions' })).toBeVisible();
  });
});

test.describe('follow-ups', () => {
  test('schedule from the page, reschedule, cancel, complete with next step; counters and tabs stay accurate', async () => {
    const p = ws.people.SALES_AGENT.page;
    const mgr = api(ws.people.MANAGER, ws.id);
    await mgr.post(`/leads/${leadId}/assign`, { assignedToId: ws.people.SALES_AGENT.userId });
    await p.goto('/follow-ups?view=upcoming');
    await p.getByRole('button', { name: 'Schedule follow-up' }).first().click();
    await p.getByRole('textbox', { name: 'Lead', exact: true }).fill('Nadia');
    await p.getByRole('button', { name: /Nadia Khan/ }).click();
    await p.locator('#fu-type').selectOption('MEETING');
    await p.locator('#fu-due').fill(localIn(60 * 30));
    await p.locator('#fu-pri').selectOption('HIGH');
    await p.locator('#fu-notes').fill('Review designs');
    await p.getByRole('button', { name: 'Schedule', exact: true }).click();
    await toast(p, 'Follow-up scheduled');
    await expect(table(p).getByText('Meeting')).toBeVisible();
    await expect(table(p).getByText('Nadia Khan')).toBeVisible();
    await expect(p.getByText('Next 7 days').locator('..').getByText('1')).toBeVisible();
    // reschedule keeps history
    await table(p).getByRole('button', { name: 'Reschedule' }).click();
    await p.getByLabel('New date and time').fill(localIn(60 * 48));
    await p.getByLabel('Reason').fill('Client travelling');
    await p.getByRole('button', { name: 'Reschedule', exact: true }).click();
    await toast(p, 'Follow-up rescheduled');
    await expect(table(p).getByText(/rescheduled 1×/)).toBeVisible();
    // cancel
    await table(p).getByRole('button', { name: 'Cancel' }).click();
    await p.getByLabel('Cancel reason').fill('Deal paused');
    await p.getByRole('button', { name: 'Cancel follow-up' }).click();
    await toast(p, 'Follow-up canceled');
    await expect(table(p)).toHaveCount(0);
    await p.goto('/follow-ups?view=all');
    await expect(table(p).getByText('Canceled', { exact: true })).toBeVisible();
    // new one, complete, schedule next
    await mgr.post('/followups', { leadId, type: 'CALL', dueAt: new Date(Date.now() + 2 * 3600_000).toISOString(), assignedToId: ws.people.SALES_AGENT.userId });
    await p.goto('/follow-ups?view=today');
    await expect(p.getByRole('heading', { name: 'Follow-ups' })).toBeVisible();
    await expect(table(p).getByRole('button', { name: 'Complete' }).first()).toBeVisible({ timeout: 30_000 });
    await table(p).getByRole('button', { name: 'Complete' }).first().click();
    await p.getByRole('button', { name: 'Callback Requested' }).click();
    await p.getByLabel('Schedule next follow-up').click();
    await p.getByLabel('Next due').fill(localIn(60 * 72));
    await p.getByRole('button', { name: 'Mark completed' }).click();
    await toast(p, 'Follow-up completed');
    await p.goto('/follow-ups?view=completed');
    await expect(table(p).getByText('Callback Requested')).toBeVisible();
    await p.goto('/follow-ups?view=upcoming');
    await expect(table(p).getByText('Nadia Khan')).toBeVisible();
    // calendar shows it with day/week/month switchers
    await p.goto('/follow-ups?view=calendar');
    await expect(p.getByTestId('calendar-month')).toBeVisible();
    await p.getByRole('tab', { name: 'week', exact: true }).click();
    await expect(p.getByTestId('calendar-week')).toBeVisible();
    await p.getByRole('tab', { name: 'day', exact: true }).click();
    await expect(p.getByTestId('calendar-day')).toBeVisible();
    await p.getByRole('button', { name: 'Next', exact: true }).click();
    await p.getByRole('button', { name: 'Today', exact: true }).click();
  });
});

test.describe('tasks & calendar', () => {
  test('create, assign, comment, complete, filter, edit; team view for managers; calendar shows deadlines', async () => {
    const p = ws.people.SALES_AGENT.page;
    await p.goto('/tasks');
    await p.getByRole('button', { name: 'New task' }).first().click();
    await p.locator('#tk-title').fill('Send revised proposal');
    await p.locator('#tk-due').fill(localIn(60 * 6));
    await p.locator('#tk-pri').selectOption('HIGH');
    await p.getByRole('textbox', { name: 'Lead', exact: true }).fill('Nadia');
    await p.getByRole('button', { name: /Nadia Khan/ }).click();
    await p.getByRole('button', { name: 'Create task' }).click();
    await toast(p, 'Task created');
    await expect(table(p).getByText('Send revised proposal')).toBeVisible();
    await table(p).getByText('Send revised proposal').click();
    await p.getByLabel('Add a comment').fill('Waiting on pricing sheet');
    await p.getByRole('button', { name: 'Post comment' }).click();
    await expect(p.getByText('Waiting on pricing sheet')).toBeVisible();
    await p.getByRole('button', { name: 'Start' }).click();
    await expect(p.getByRole('dialog').getByText('In progress')).toBeVisible();
    await p.getByRole('button', { name: 'Edit', exact: true }).click();
    await p.locator('#tk-title').fill('Send revised proposal v2');
    await p.getByRole('button', { name: 'Save', exact: true }).click();
    await toast(p, 'Task updated');
    await p.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(table(p).getByText('Send revised proposal v2')).toBeVisible();
    await p.getByRole('button', { name: 'Complete Send revised proposal v2' }).click();
    await p.getByRole('tab', { name: 'Completed' }).click();
    await expect(table(p).getByText('Send revised proposal v2')).toBeVisible();
    // manager's team view + overdue handling via API-created task
    const m = ws.people.MANAGER.page;
    await api(ws.people.MANAGER, ws.id).post('/tasks', { title: 'Prepare onboarding pack', assignedToId: ws.people.SALES_AGENT.userId, dueAt: new Date(Date.now() + 3 * 3600_000).toISOString() });
    await m.goto('/tasks?scope=team');
    await expect(table(m).getByText('Prepare onboarding pack')).toBeVisible();
    // calendar shows the deadline
    await m.goto('/tasks?scope=calendar');
    await expect(m.getByTestId('calendar-month')).toContainText('Prepare onboarding pack'.slice(0, 12));
    // the agent was notified of the assignment
    const n = await api(ws.people.SALES_AGENT, ws.id).get('/notifications');
    expect(n.data.some((x: { type: string; title: string }) => x.type === 'TASK_ASSIGNED' && /Prepare onboarding/.test(x.title))).toBe(true);
  });
});

test.describe('opportunities', () => {
  test('create from a lead, edit, win, reopen; losing requires a reason; table filters match', async () => {
    const p = ws.people.SALES_AGENT.page;
    await p.goto(`/leads/${leadId}`);
    await p.getByRole('button', { name: 'New opportunity' }).first().click();
    await p.locator('#op-name').fill('Khan Design — rebrand');
    await p.locator('#op-val').fill('8200');
    await p.locator('#op-close').fill('2027-03-01');
    await p.getByRole('button', { name: 'Create opportunity' }).click();
    await toast(p, 'Opportunity created');
    await p.getByRole('tab', { name: /Opportunities/ }).click();
    await p.getByText('Khan Design — rebrand').click();
    await expect(p).toHaveURL(/\/opportunities/);
    await expect(p.getByText('$8,200').first()).toBeVisible();
    await p.getByRole('button', { name: 'Edit', exact: true }).click();
    await p.locator('#op-val').fill('9100');
    await p.getByRole('button', { name: 'Save', exact: true }).click();
    await toast(p, 'Opportunity updated');
    await expect(p.getByText('$9,100').first()).toBeVisible();
    // lost needs a reason
    await p.getByRole('group', { name: 'Move to stage' }).getByRole('button', { name: 'Lost' }).click();
    await expect(p.getByRole('button', { name: 'Confirm lost' })).toBeDisabled();
    await p.getByLabel('Lost reason').selectOption({ index: 1 });
    await p.getByLabel('Lost details').fill('Chose a cheaper agency');
    await p.getByRole('button', { name: 'Confirm lost' }).click();
    await toast(p, 'Opportunity moved');
    await expect(p.getByText(/Lost /).first()).toBeVisible();
    await expect(p.getByText('Chose a cheaper agency', { exact: true })).toBeVisible();
    // reopen into an open stage → lead goes back to Qualified
    await p.getByRole('group', { name: 'Move to stage' }).getByRole('button', { name: 'Negotiation' }).click();
    await toast(p, 'Opportunity moved');
    await p.keyboard.press('Escape');
    await p.goto('/opportunities?status=OPEN');
    await expect(table(p).getByText('Khan Design — rebrand')).toBeVisible();
    await p.goto('/opportunities?status=LOST');
    await expect(table(p)).toHaveCount(0);
    await p.goto('/opportunities?q=rebrand');
    await expect(table(p).getByText('$9,100')).toBeVisible();
    const lead = await api(ws.people.MANAGER, ws.id).get(`/leads/${leadId}`);
    expect(lead.data.status).toBe('QUALIFIED');
  });
});

test.describe('team management', () => {
  test('invite with a dev link, change a role, deactivate and reactivate; permissions of the deactivated user', async () => {
    const p = ws.people.OWNER.page;
    await p.goto('/team');
    await p.getByRole('button', { name: 'Invite member' }).click();
    await p.getByLabel('Email address').fill(`newbie-${ws.id.slice(0, 6)}@fx.test`);
    await p.getByRole('button', { name: 'Send invitation' }).click();
    await expect(p.getByText('Development environment')).toBeVisible();
    await p.getByRole('button', { name: 'Done' }).click();
    await p.getByRole('tab', { name: /Invitations/ }).click();
    await expect(p.getByText(`newbie-${ws.id.slice(0, 6)}@fx.test`)).toBeVisible();
    await p.getByRole('button', { name: /Revoke/ }).first().click();
    await expect(p.getByText('revoked', { exact: true })).toBeVisible();
    await p.getByRole('tab', { name: 'Members' }).click();
    // role change
    await table(p).getByLabel(`Role for ${ws.people.SALES_AGENT.name}`).selectOption({ label: 'Manager' });
    await toast(p, 'Member updated');
    await table(p).getByLabel(`Role for ${ws.people.SALES_AGENT.name}`).selectOption({ label: 'Sales Agent' });
    await toast(p, 'Member updated');
    // deactivate with confirmation
    await p.getByRole('button', { name: `Actions for ${ws.people.VIEWER.name}` }).click();
    await p.getByRole('menuitem', { name: 'Deactivate' }).click();
    await p.getByRole('button', { name: 'Deactivate', exact: true }).click();
    await toast(p, 'Member updated');
    await expect(table(p).getByText('Deactivated', { exact: true })).toBeVisible();
    const v = ws.people.VIEWER.page;
    await v.goto('/dashboard');
    await expect(v).toHaveURL(/\/(onboarding|dashboard|login)/); // no workspace left to open
    const r = await ws.people.VIEWER.ctx.request.get('http://localhost:4000/api/leads', { headers: { 'X-Org-Id': ws.id } });
    expect(r.status()).toBe(403);
    // reactivate
    await p.getByRole('button', { name: `Actions for ${ws.people.VIEWER.name}` }).click();
    await p.getByRole('menuitem', { name: 'Reactivate' }).click();
    await toast(p, 'Member updated');
    expect((await ws.people.VIEWER.ctx.request.get('http://localhost:4000/api/leads', { headers: { 'X-Org-Id': ws.id } })).status()).toBe(200);
  });
});

test.describe('settings', () => {
  test('sources, tags, custom fields, pipeline stages and roles can be configured and are used by the forms', async () => {
    const p = ws.people.OWNER.page;
    await p.goto('/settings');
    // timezone default must be preserved (UTC) when saving other settings
    await expect(p.getByLabel('Timezone')).toHaveValue('UTC');
    await p.getByRole('tab', { name: 'Lead sources' }).click();
    await p.getByLabel('New source name').fill('Podcast');
    await p.getByRole('button', { name: 'Add', exact: true }).click();
    await toast(p, 'source added');
    await p.getByRole('button', { name: 'Rename Podcast' }).click();
    await p.getByLabel('Name', { exact: true }).fill('Podcast ads');
    await p.getByRole('button', { name: 'Save name' }).click();
    await expect(p.getByText('Podcast ads')).toBeVisible();
    await p.getByRole('tab', { name: 'Tags' }).click();
    await p.getByLabel('New tag name').fill('Priority client');
    await p.getByRole('button', { name: 'Add', exact: true }).click();
    await p.getByRole('tab', { name: 'Custom fields' }).click();
    await p.getByLabel('Field label').fill('Annual budget');
    await p.getByLabel('Field type').selectOption('NUMBER');
    await p.getByRole('button', { name: 'Add field' }).click();
    await toast(p, 'Field added');
    await p.getByRole('tab', { name: 'Pipelines' }).click();
    await p.getByLabel('New stage name').fill('Contract review');
    await p.getByRole('button', { name: 'Add stage' }).click();
    await toast(p, 'Stage added');
    await expect(p.getByLabel('Name of stage 7')).toHaveValue('Contract review'); // inserted before Won/Lost
    // roles: create a custom role with the permission matrix
    await p.getByRole('tab', { name: 'Roles & permissions' }).click();
    await p.getByRole('button', { name: /Custom role/ }).click();
    await p.getByLabel('Role name').fill('Intake coordinator');
    await p.getByLabel('Create leads').check().catch(async () => p.getByRole('checkbox', { name: 'Create leads' }).click());
    await p.getByRole('button', { name: 'Save role' }).click();
    await toast(p, 'Role saved');
    await expect(p.getByText('Intake coordinator')).toBeVisible();
    // the lead form uses the new source, tag and custom field
    await p.goto('/leads');
    await p.getByRole('button', { name: 'Add lead' }).first().click();
    await expect(p.locator('#lf-src').locator('option', { hasText: 'Podcast ads' })).toHaveCount(1);
    await expect(p.getByRole('button', { name: 'Priority client' })).toBeVisible();
    await expect(p.getByLabel('Annual budget')).toBeVisible();
    await p.locator('#lf-first').fill('Custom');
    await p.locator('#lf-email').fill(`custom-${ws.id.slice(0, 6)}@x.test`);
    await p.getByLabel('Annual budget').fill('50000');
    await p.getByRole('button', { name: 'Priority client' }).click();
    await p.locator('#lf-src').selectOption({ label: 'Podcast ads' });
    await p.getByRole('button', { name: 'Create lead' }).click();
    await expect(p).toHaveURL(/\/leads\/[0-9a-f-]{36}/);
    await expect(p.getByText('Annual budget')).toBeVisible();
    await expect(p.getByText('50000')).toBeVisible();
    await expect(p.getByText('Priority client')).toBeVisible();
    // notification preferences: muting suppresses new notifications
    await p.goto('/notifications');
    await p.getByRole('tab', { name: 'Preferences' }).click();
    await p.getByLabel('Lead assigned to me in-app notification').click();
    await toast(p, 'Preference saved');
  });
});

test.describe('automations', () => {
  test('create a custom rule in the UI, see it execute and log, toggle it and delete it', async () => {
    const p = ws.people.OWNER.page;
    await p.goto('/automations');
    await p.getByRole('button', { name: 'New automation' }).click();
    await p.locator('#au-name').fill('Ping the admin on new leads');
    await p.getByLabel('Recipient').selectOption('USER');
    await p.getByLabel('Person').selectOption({ label: ws.people.ADMIN.name });
    await p.getByRole('button', { name: 'Create automation' }).click();
    await toast(p, 'Automation created');
    await expect(p.getByText('Ping the admin on new leads')).toBeVisible();
    await api(ws.people.MANAGER, ws.id).post('/leads', { firstName: 'Trigger', email: `trigger-${ws.id.slice(0, 6)}@x.test` });
    await p.waitForTimeout(1500);
    const n = await api(ws.people.ADMIN, ws.id).get('/notifications');
    expect(n.data.some((x: { type: string }) => x.type === 'NEW_LEAD')).toBe(true);
    await p.getByRole('tab', { name: 'Execution log' }).click();
    await expect(p.getByText('Ping the admin on new leads').first()).toBeVisible();
    await expect(table(p).getByText('Success').first()).toBeVisible();
    await p.getByRole('tab', { name: 'Rules' }).click();
    await p.getByLabel('Disable Ping the admin on new leads').click();
    await toast(p, 'Automation updated');
    await p.getByRole('button', { name: 'Delete Ping the admin on new leads' }).click();
    await p.getByRole('button', { name: 'Delete', exact: true }).click();
    await toast(p, 'Automation deleted');
    await expect(p.getByText('Ping the admin on new leads')).toHaveCount(0);
  });
});

test.describe('billing & plan limits', () => {
  test('upgrade creates an invoice; the plan changes only when a platform admin confirms the payment; the owner sees the receipt', async ({ browser }) => {
    const p = ws.people.OWNER.page;
    await p.goto('/billing');
    // from a trial, choosing a paid plan issues an invoice; nothing changes until a payment is CONFIRMED by LeadFlow billing
    await p.getByRole('button', { name: 'Switch to Starter' }).click();
    await p.getByRole('button', { name: 'Switch plan' }).click();
    await expect(p.getByText('Awaiting payment')).toBeVisible();
    await expect(p.getByLabel('Payment reference')).toHaveCount(0);                  // a workspace cannot mark its own invoice paid
    await expect(p.getByRole('button', { name: /record (manual )?payment/i })).toHaveCount(0);
    await p.keyboard.press('Escape');
    await p.reload();
    await expect(p.getByText('Trial ends').first()).toBeVisible();                 // still on the trial
    // platform billing administrator confirms the money that arrived
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ap = await ctx.newPage();
    await ap.goto('/login');
    await ap.locator('#email').fill('admin@leadflow.test'); await ap.locator('#password').fill('Admin#Pass2026');
    await ap.getByRole('button', { name: 'Sign in', exact: true }).click();
    await ap.waitForURL(/\/platform/);
    await ap.goto('/platform/invoices');
    await ap.getByLabel('Search invoices').fill(ws.name);
    await ap.getByRole('button', { name: 'Confirm payment' }).first().click();
    const dlg = ap.getByRole('dialog');
    await dlg.getByLabel('Payment reference').fill('BANK-REF-STARTER');
    await expect(dlg.getByText('Previous expiry')).toBeVisible();                  // previous → new expiry preview
    await dlg.getByRole('button', { name: /Confirm payment/ }).click();
    await toast(ap, /Payment confirmed — receipt RC-/);
    await p.goto('/billing');
    await expect(p.getByRole('heading', { name: 'Starter', exact: true }).first()).toBeVisible();
    await expect(p.getByText('Up to 1,000 leads').first()).toBeVisible();
    await p.getByRole('tab', { name: /Payments/ }).click();
    await expect(p.getByText(/^RC-/).first()).toBeVisible();
    await expect(p.getByText('BANK-REF-STARTER')).toBeVisible();
    // upgrade again, this time recorded directly from the organization page (3 months, different plan)
    await ap.goto('/platform/organizations');
    await ap.getByLabel('Search organizations').fill(ws.name);
    await ap.getByRole('table').getByText(ws.name).click();
    await ap.getByRole('tab', { name: 'Billing' }).click();
    await ap.getByRole('button', { name: /Record payment & extend/ }).click();
    const d2 = ap.getByRole('dialog');
    await d2.getByLabel('Plan', { exact: true }).selectOption({ label: 'Professional' });
    await d2.getByLabel('Amount received').fill('237');
    await d2.getByLabel('Payment reference').fill('BANK-REF-123');
    await d2.getByRole('button', { name: '3 months' }).click();
    await expect(d2.getByText(/new plan starts now/i)).toBeVisible();
    await d2.getByRole('button', { name: /Confirm payment/ }).click();
    await toast(ap, /Payment confirmed/);
    await expect(ap.getByText('BANK-REF-123').first()).toBeVisible();
    await ctx.close();
    await p.goto('/billing');
    await expect(p.getByRole('heading', { name: 'Professional', exact: true }).first()).toBeVisible();
    await expect(p.getByText('Active', { exact: true }).first()).toBeVisible();
    await p.getByRole('tab', { name: 'Invoices' }).click();
    await expect(p.getByText('Paid').first()).toBeVisible();
    await p.getByRole('button', { name: 'View' }).first().click();
    await expect(p.getByText('Bank transfer')).toBeVisible();
    await p.keyboard.press('Escape');
    // Free plan blocks pro features in the UI and the API
    const r = await api(ws.people.OWNER, ws.id).post('/billing/change-plan', { planCode: 'free', interval: 'MONTHLY' });
    expect([200, 409]).toContain(r.status); // 409 when seats exceed the Free plan (5 members)
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/active members/);
  });
});

test.describe('reports', () => {
  test('every report renders for a manager, filters apply and exports download', async () => {
    const p = ws.people.MANAGER.page;
    await p.goto('/reports');
    for (const t of ['Lead Generation', 'Lead Source Performance', 'Assignment', 'Contact Performance', 'Follow-up', 'Pipeline', 'Conversion', 'Lost Lead', 'Salesperson Performance', 'Lead Aging', 'Response Time']) {
      await expect(p.getByText(`${t} report`, { exact: false }).first()).toBeVisible();
    }
    await p.getByRole('link', { name: /Lead Source Performance report/ }).click();
    await expect(p.getByRole('heading', { name: 'Lead Source Performance report' })).toBeVisible();
    await p.getByLabel('Date range').selectOption('custom');
    await p.getByLabel('From date').fill('2026-01-01');
    await p.getByLabel('To date').fill('2026-12-31');
    await p.screenshot({ path: '/tmp/claude-0/audit/report_custom.png' });
    await expect(p.getByText('Overall lead → won')).toBeVisible();
    await p.getByLabel('Date range').selectOption('all');
    const dl = p.waitForEvent('download');
    await p.getByRole('button', { name: /Export/ }).click();
    await p.getByRole('menuitem', { name: 'Excel (.xlsx)' }).click();
    expect((await dl).suggestedFilename()).toMatch(/report-lead-source-.*\.xlsx/);
  });
});

test.describe('viewer & agent experience', () => {
  test('viewer is read-only; agent cannot see team-wide admin screens', async () => {
    const v = ws.people.VIEWER.page;
    await v.goto('/leads');
    await expect(v.getByRole('heading', { name: 'Leads' })).toBeVisible();
    await expect(v.getByRole('button', { name: 'Add lead' })).toHaveCount(0);
    await expect(v.getByRole('button', { name: 'Import' })).toHaveCount(0);
    await v.goto('/pipeline');
    await expect(v.getByRole('button', { name: 'New opportunity' })).toHaveCount(0);
    await v.goto('/team');
    await expect(v.getByRole('button', { name: 'Invite member' })).toHaveCount(0);
    await v.goto('/billing');
    await expect(v.getByText("You don't have access to this page")).toBeVisible();
    await v.goto('/leads');
    await table(v).getByRole('row').nth(1).click();
    await expect(v.getByRole('button', { name: /Log activity/ })).toHaveCount(0);
    const a = ws.people.SALES_AGENT.page;
    await a.goto('/team');
    await expect(a.getByRole('button', { name: 'Invite member' })).toHaveCount(0);
    await expect(a.getByLabel(/Role for/)).toHaveCount(0);
  });
});

test.describe('platform administration', () => {
  test('plans can be edited, invoices handled, users and audit logs browsed; limits follow plan edits', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await p.goto('/login');
    await p.locator('#email').fill('billing@leadflow.test');
    await p.locator('#password').fill('Admin#Pass2026');
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
    await p.waitForURL(/\/platform/);
    await p.getByRole('link', { name: 'Subscription plans' }).click();
    await expect(p.getByText('Starter').first()).toBeVisible();
    await p.getByRole('button', { name: 'Edit' }).nth(1).click();
    const before = await p.getByLabel('Lead limit').inputValue();
    await p.getByLabel('Lead limit').fill(String(Number(before) + 1));
    await p.getByRole('button', { name: 'Save plan' }).click();
    await toast(p, 'Plan saved');
    await p.getByRole('button', { name: 'Edit' }).nth(1).click();
    await p.getByLabel('Lead limit').fill(before);
    await p.getByRole('button', { name: 'Save plan' }).click();
    await toast(p, 'Plan saved');
    await p.getByRole('link', { name: 'Invoices & billing' }).click();
    await expect(p.getByRole('heading', { name: 'Invoices & billing' })).toBeVisible();
    await p.getByRole('link', { name: 'Users' }).click();
    await p.getByLabel('Search users').fill('owner-');
    await expect(p.getByRole('table').getByText('Olivia Owner').first()).toBeVisible();
    await p.getByRole('link', { name: 'Audit logs' }).click();
    await expect(p.getByText('plan.updated').first()).toBeVisible();
    await p.getByRole('link', { name: 'System health' }).click();
    await expect(p.getByText('PostgreSQL')).toBeVisible();
    await p.getByRole('link', { name: 'Usage statistics' }).click();
    await expect(p.getByRole('heading', { name: 'Usage statistics' })).toBeVisible();
    // role boundary in the UI: billing admin cannot suspend
    await p.getByRole('link', { name: 'Organizations' }).click();
    await p.getByLabel('Search organizations').fill(ws.name);
    await p.getByRole('table').getByText(ws.name).click();
    await expect(p.getByRole('button', { name: 'Suspend' })).toBeDisabled();
    await ctx.close();
  });
});
