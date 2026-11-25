import { expect, test } from '@playwright/test';
import { API, PASSWORD, inviteLinkFor, localIn, login, newUser, register, toast, uniq } from './helpers';

/**
 * The complete product journey from the acceptance criteria:
 * register → verify → workspace → invite → assign → call → follow-up → calendar → reminder → complete →
 * pipeline → opportunity won → history → dashboard → reports → tenant isolation → plan limits → platform admin.
 */
test('end-to-end CRM lifecycle', async ({ browser }) => {
  const id = uniq();
  const company = `Acme ${id}`;
  const owner = { name: 'Olivia Owner', email: `owner-${id}@e2e.test` };
  const manager = { name: 'Mark Manager', email: `manager-${id}@e2e.test` };
  const agent = { name: 'Sam Agent', email: `agent-${id}@e2e.test` };
  const leadName = `Priya Shah${id.slice(-3)}`;
  const [leadFirst, leadLast] = [leadName.split(' ')[0]!, leadName.split(' ')[1]!];
  let leadUrl = '';

  const ownerSession = await newUser(browser);
  const op = ownerSession.page;

  await test.step('1-4. Owner registers, verifies email, creates workspace and completes onboarding (inviting two teammates)', async () => {
    await register(op, owner.name, owner.email);
    await op.getByRole('link', { name: 'Continue to sign in' }).click();
    await login(op, owner.email);
    await expect(op).toHaveURL(/onboarding/);
    await op.locator('#cn').fill(company);
    await op.getByRole('button', { name: 'Continue' }).click();               // company → details
    await expect(op.getByRole('heading', { name: 'Business details' })).toBeVisible();
    await op.getByRole('button', { name: 'Continue' }).click();               // details → sales setup
    await expect(op.getByRole('heading', { name: 'Sales setup' })).toBeVisible();
    await op.getByRole('button', { name: 'Continue' }).click();               // sales setup → invite
    await expect(op.getByRole('heading', { name: 'Invite your team' })).toBeVisible();
    await op.getByLabel('Team member email').first().fill(manager.email);
    await op.getByLabel('Role').first().selectOption('MANAGER');
    await op.getByRole('button', { name: 'Add another' }).click();
    await op.getByLabel('Team member email').nth(1).fill(agent.email);
    await op.getByRole('button', { name: 'Finish setup' }).click();
    await expect(op).toHaveURL(/dashboard/);
    await expect(op.getByRole('button', { name: 'Switch workspace' })).toContainText(company);
  });

  const mgr = await newUser(browser);
  const ag = await newUser(browser);
  for (const [who, person] of [[mgr, manager], [ag, agent]] as const) {
    await test.step(`5. ${person.name} accepts the invitation and joins the workspace`, async () => {
      const link = await inviteLinkFor(who.page, person.email);
      await who.page.goto(link);
      await expect(who.page.getByText(company)).toBeVisible();
      await who.page.getByRole('link', { name: 'Create account to accept' }).click();
      await who.page.locator('#name').fill(person.name);
      await who.page.locator('#password').fill(PASSWORD);
      await who.page.getByRole('button', { name: 'Create account' }).click();   // invited email counts as verified
      await who.page.waitForURL(/\/login/);
      await who.page.locator('#password').fill(PASSWORD);
      await who.page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await who.page.getByRole('button', { name: /Accept & join workspace/ }).click();
      await expect(who.page).toHaveURL(/dashboard/);
      await expect(who.page.getByRole('button', { name: 'Switch workspace' })).toContainText(company);
    });
  }

  await test.step('6-7. Manager creates a lead and assigns it to the salesperson', async () => {
    const p = mgr.page;
    await p.goto('/leads');
    await expect(p.getByText('No leads yet')).toBeVisible();
    await p.getByRole('button', { name: 'Add lead' }).first().click();
    await p.locator('#lf-first').fill(leadFirst);
    await p.locator('#lf-last').fill(leadLast);
    await p.locator('#lf-email').fill(`priya-${id}@shah.test`);
    await p.locator('#lf-co').fill('Shah Interiors');
    await p.locator('#lf-asg').selectOption({ label: agent.name });
    await p.getByRole('button', { name: 'Create lead' }).click();
    await expect(p).toHaveURL(/\/leads\/[0-9a-f-]{36}/);
    await expect(p.getByRole('heading', { name: new RegExp(leadName) })).toBeVisible();
    await expect(p.getByText(agent.name).first()).toBeVisible();
    leadUrl = p.url();
    // duplicate protection
    await p.goto('/leads');
    await p.getByRole('button', { name: 'Add lead' }).first().click();
    await p.locator('#lf-first').fill('Dup');
    await p.locator('#lf-email').fill(`PRIYA-${id}@shah.test`);
    await p.getByRole('button', { name: 'Create lead' }).click();
    await expect(p.getByText('already exists').first()).toBeVisible();
    await p.getByRole('button', { name: 'Cancel' }).click();
  });

  await test.step('8-9. Salesperson sees the assigned lead; records a call', async () => {
    const p = ag.page;
    await p.goto('/leads');
    await expect(p.getByRole('table').getByText(leadName)).toBeVisible();
    await p.getByRole('table').getByText(leadName).click();
    await expect(p.getByRole('heading', { name: new RegExp(leadName) })).toBeVisible();
    await p.getByRole('button', { name: /Log activity/ }).click();
    await p.getByLabel('Details').fill('Introduced our fit-out packages. Very interested.');
    await p.getByRole('button', { name: 'Save to timeline' }).click();
    await toast(p, 'Activity logged');
    await expect(p.getByText('Call logged')).toBeVisible();
    await expect(p.getByText('Contacted', { exact: true }).first()).toBeVisible(); // status moved to Contacted
  });

  await test.step('10-12. Salesperson schedules a follow-up which appears in the calendar', async () => {
    const p = ag.page;
    await p.getByRole('button', { name: /Follow-up/ }).first().click();
    await p.locator('#fu-due').fill(localIn(10));
    await p.locator('#fu-notes').fill('Walk through the quote');
    await p.getByRole('button', { name: 'Schedule', exact: true }).click();
    await toast(p, 'Follow-up scheduled');
    await p.goto('/follow-ups?view=calendar');
    await expect(p.getByTestId('calendar-month')).toContainText('Phone Call');
  });

  await test.step('13. Background scheduler generates the reminder notification', async () => {
    const r = await ag.page.request.post(`${API}/api/dev/scheduler/tick`);
    expect(r.ok()).toBeTruthy();
    await ag.page.goto('/dashboard');
    const bell = ag.page.getByRole('button', { name: /Notifications, \d+ unread/ });
    await expect(bell).toBeVisible();
    await bell.click();
    await expect(ag.page.getByText(/Follow-up due soon/)).toBeVisible();
    await ag.page.keyboard.press('Escape');
  });

  await test.step('14. Salesperson completes the follow-up with an outcome', async () => {
    const p = ag.page;
    await p.goto(leadUrl.replace(/^https?:\/\/[^/]+/, ''));
    await p.getByRole('tab', { name: /Follow-ups/ }).click();
    await p.getByRole('button', { name: 'Complete' }).click();
    await expect(p.getByRole('button', { name: 'Mark completed' })).toBeDisabled();   // outcome is mandatory
    await p.getByRole('button', { name: 'Interested', exact: true }).click();
    await p.getByLabel('Notes').fill('Wants a proposal by Friday');
    await p.getByRole('button', { name: 'Mark completed' }).click();
    await toast(p, 'Follow-up completed');
    await expect(p.getByText(/Interested/).first()).toBeVisible();
  });

  await test.step('15-17. Opportunity created, moved through the pipeline and won', async () => {
    const p = ag.page;
    await p.getByRole('button', { name: 'New opportunity' }).first().click();
    await p.locator('#op-val').fill('15000');
    await p.getByRole('button', { name: 'Create opportunity' }).click();
    await toast(p, 'Opportunity created');
    await p.goto('/pipeline');
    const card = p.getByRole('button', { name: /Opportunity .*Shah/ });
    await expect(card).toBeVisible();
    // stage change via the detail panel
    await card.click();
    await p.getByRole('group', { name: 'Move to stage' }).getByRole('button', { name: 'Qualified' }).click();
    await toast(p, 'Opportunity moved');
    await p.keyboard.press('Escape');
    await expect(p.locator('section[aria-label="Qualified stage"]').getByRole('button', { name: /Opportunity/ })).toBeVisible();
    // drag & drop between columns (real pointer events) — Qualified → Negotiation → Won
    const drag = async (fromStage: string, toStage: string) => {
      await p.evaluate((n) => { const sec = document.querySelector(`section[aria-label="${n} stage"]`) as HTMLElement; (document.querySelector('[data-testid=kanban]') as HTMLElement).scrollLeft = sec.offsetLeft - 24; }, fromStage);
      await p.waitForTimeout(250);
      const src = await p.locator(`section[aria-label="${fromStage} stage"]`).getByRole('button', { name: /Opportunity/ }).boundingBox();
      const dst = await p.locator(`section[aria-label="${toStage} stage"]`).boundingBox();
      expect(src && dst, `${fromStage}→${toStage} boxes`).toBeTruthy();
      await p.mouse.move(src!.x + src!.width / 2, src!.y + src!.height / 2);
      await p.mouse.down();
      await p.mouse.move(src!.x + src!.width / 2 + 12, src!.y + src!.height / 2 + 12, { steps: 4 });
      await p.mouse.move(dst!.x + dst!.width / 2, dst!.y + 110, { steps: 30 });
      await p.mouse.up();
    };
    await drag('Qualified', 'Negotiation');
    await toast(p, 'Moved to Negotiation');
    await drag('Negotiation', 'Won');
    await toast(p, /won/i);
    await p.reload();
    await expect(p.locator('section[aria-label="Won stage"]').getByRole('button', { name: /Opportunity/ })).toBeVisible();
  });

  await test.step('18. Activity history reflects every important change', async () => {
    const p = ag.page;
    await p.goto(leadUrl.replace(/^https?:\/\/[^/]+/, ''));
    for (const text of ['Lead created', `Assigned to ${agent.name}`, 'Call logged', 'Follow-up scheduled', 'Follow-up completed', 'Opportunity created', 'Won:', 'Lead converted']) {
      await expect(p.getByText(text, { exact: false }).first(), text).toBeVisible();
    }
    await expect(p.getByText('Won', { exact: true }).first()).toBeVisible();
  });

  await test.step('19-20. Dashboard metrics and reports show the real data', async () => {
    const p = mgr.page;
    await p.goto('/dashboard');
    await expect(p.getByText('Conversion rate').first()).toBeVisible();
    await expect(p.getByText('100%').first()).toBeVisible();                 // 1 won / 1 closed
    await expect(p.getByText('$15,000 won value').first()).toBeVisible();
    await p.goto('/reports/conversion');
    await expect(p.getByRole('heading', { name: 'Conversion report' })).toBeVisible();
    await expect(p.getByText('Conversion rate').first()).toBeVisible();
    await expect(p.getByText('$15,000').first()).toBeVisible();
    await p.goto('/reports/salesperson');
    await expect(p.getByRole('cell', { name: agent.name })).toBeVisible();
  });

  await test.step('21. Another company registers and cannot see the first company\'s data', async () => {
    const rival = await newUser(browser);
    const rp = rival.page;
    const rEmail = `rival-${id}@e2e.test`;
    await register(rp, 'Rita Rival', rEmail);
    await rp.getByRole('link', { name: 'Continue to sign in' }).click();
    await login(rp, rEmail);
    await rp.locator('#cn').fill(`Rival Co ${id}`);
    await rp.getByRole('button', { name: 'Continue' }).click();
    await rp.getByRole('button', { name: 'Skip setup' }).click();
    await expect(rp).toHaveURL(/dashboard/);
    await rp.goto(leadUrl.replace(/^https?:\/\/[^/]+/, ''));
    await expect(rp.getByText('Lead not found')).toBeVisible();
    await rp.goto('/leads');
    await expect(rp.getByText(leadName)).toHaveCount(0);
    // API level: spoofing the other tenant's id is rejected
    const orgA = await op.evaluate(() => localStorage.getItem('lf_org'));
    const spoof = await rp.request.get(`${API}/api/leads`, { headers: { 'X-Org-Id': orgA! } });
    expect(spoof.status()).toBe(403);
    expect((await spoof.json()).error.code).toBe('NOT_A_MEMBER');
    await rival.ctx.close();
  });

  await test.step('22. Subscription limits are enforced (cannot downgrade below current usage)', async () => {
    await op.goto('/billing');
    await expect(op.getByRole('heading', { name: 'Subscription & billing' })).toBeVisible();
    await op.getByRole('button', { name: 'Switch to Free' }).click();
    await op.getByRole('button', { name: 'Switch plan' }).click();
    await toast(op, /active members/);
  });

  await test.step('23. Platform administrator manages organizations and subscriptions', async () => {
    const adminSession = await newUser(browser);
    const ap = adminSession.page;
    await login(ap, 'admin@leadflow.test', 'Admin#Pass2026', /\/platform/);
    await expect(ap.getByRole('heading', { name: 'Platform overview' })).toBeVisible();
    await ap.getByRole('link', { name: 'Organizations' }).click();
    await ap.getByLabel('Search organizations').fill(company);
    await ap.getByRole('table').getByText(company).click();
    await expect(ap.getByRole('heading', { name: company })).toBeVisible();
    await expect(ap.getByText('Platform administrators cannot read', { exact: false })).toHaveCount(0);
    await expect(ap.getByText('intentionally not accessible', { exact: false })).toBeVisible();   // privacy notice, no lead data
    await ap.getByRole('button', { name: 'Suspend' }).click();
    await ap.getByLabel('Suspension reason').fill('E2E suspension check');
    await ap.getByRole('button', { name: 'Suspend organization' }).click();
    await toast(ap, 'Organization suspended');
    await op.goto('/dashboard');
    await expect(op.getByText('This workspace is suspended').first()).toBeVisible();
    await ap.getByRole('button', { name: 'Re-activate' }).click();
    await toast(ap, 'Organization re-activated');
    await op.goto('/dashboard');
    await expect(op.getByText('Dashboard', { exact: true }).first()).toBeVisible();
    await ap.getByRole('button', { name: 'Override plan / status' }).click();          // plan / status override (extending an expiry is done in Billing → Record payment / Extend)
    const dlg = ap.getByRole('dialog');
    await dlg.getByLabel('Status').selectOption('ACTIVE');
    await dlg.getByLabel('Note').fill('Acceptance test override');
    await dlg.getByRole('button', { name: 'Apply override' }).click();
    await toast(ap, 'Subscription adjusted');
    await adminSession.ctx.close();
  });

  await Promise.all([ownerSession.ctx.close(), mgr.ctx.close(), ag.ctx.close()]);
});
