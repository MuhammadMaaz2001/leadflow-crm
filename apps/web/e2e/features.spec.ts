import { expect, test } from '@playwright/test';
import { api, createWorkspace, type Workspace } from './fixtures';
import { toast, uniq } from './helpers';
import { MockIdp } from '../../api/test/mock-idp';

let ws: Workspace;
test.describe.configure({ mode: 'default' });
test.beforeAll(async ({ browser }) => { ws = await createWorkspace(browser, 'Features'); });
test.afterAll(async () => { for (const p of Object.values(ws?.people ?? {})) await p.ctx.close(); });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');

test('lead attachments: upload with validation, download, permissions, delete', async () => {
  const owner = api(ws.people.OWNER, ws.id);
  const lead = (await owner.post('/leads', { firstName: 'Attach', lastName: uniq(), email: `att-${uniq()}@x.test` })).body.data.id as string;
  const p = ws.people.OWNER.page;
  await p.goto(`/leads/${lead}`);
  await p.getByRole('tab', { name: 'Files' }).click();
  await expect(p.getByText('No files yet')).toBeVisible();
  await p.getByTestId('attachment-input').setInputFiles([{ name: 'Proposal 2026.pdf', mimeType: 'application/pdf', buffer: PDF }, { name: 'notes.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') }]);
  await toast(p, '2 files uploaded');
  const list = p.getByRole('list', { name: 'Attachments' });
  await expect(list.getByText('Proposal 2026.pdf')).toBeVisible();
  await expect(list.getByText('notes.csv')).toBeVisible();
  await expect(list.getByText(/Olivia Owner/).first()).toBeVisible();                  // uploader
  await expect(list.getByText(/\d+(\.\d)? B/).first()).toBeVisible();                  // size
  // content validation: an executable renamed to .pdf is refused with a clear reason, the good file still arrives
  await p.getByTestId('attachment-input').setInputFiles([{ name: 'evil.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]) }]);
  await expect(p.getByRole('alert').getByText(/Executable files/)).toBeVisible();
  await expect(list.getByText('evil.pdf')).toHaveCount(0);
  // timeline shows the activity
  await p.getByRole('tab', { name: 'Timeline' }).click();
  await expect(p.getByText('Attached "Proposal 2026.pdf"')).toBeVisible();
  await p.getByRole('tab', { name: 'Files' }).click();
  // secure download through the API
  const dl = p.waitForEvent('download');
  await p.getByRole('button', { name: 'Download Proposal 2026.pdf' }).click();
  expect((await dl).suggestedFilename()).toBe('Proposal 2026.pdf');
  // a viewer can read and download but not upload or remove
  const v = ws.people.VIEWER.page;
  await v.goto(`/leads/${lead}`); await v.getByRole('tab', { name: 'Files' }).click();
  await expect(v.getByRole('list', { name: 'Attachments' }).getByText('notes.csv')).toBeVisible();
  await expect(v.getByTestId('attachment-input')).toHaveCount(0);
  await expect(v.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  // delete
  await p.getByRole('button', { name: 'Remove notes.csv' }).click();
  await p.getByRole('button', { name: 'Remove', exact: true }).click();
  await toast(p, 'File removed');
  await expect(list.getByText('notes.csv')).toHaveCount(0);
});

test('calendar: drag a follow-up to another day, revert on failure, reschedule dialog, read-only for viewers', async () => {
  const owner = api(ws.people.OWNER, ws.id);
  const tz = (await owner.get('/organizations/current')).data.organization.timezone as string;
  const key = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const lead = (await owner.post('/leads', { firstName: 'Cal', lastName: uniq(), email: `cal-${uniq()}@x.test` })).body.data.id as string;
  const due = new Date(Date.now() + 2 * 86_400_000);
  const fu = (await owner.post('/followups', { leadId: lead, type: 'CALL', dueAt: due.toISOString(), assignedToId: ws.people.OWNER.userId, priority: 'MEDIUM' })).body.data.id as string;
  const from = key(due), to = key(new Date(due.getTime() + 86_400_000));
  const p = ws.people.OWNER.page;
  await p.goto('/follow-ups?view=calendar');
  const chip = (day: string) => p.getByTestId(`cal-day-${day}`).getByTestId(`cal-event-followup-${fu}`);
  await expect(chip(from)).toBeVisible();
  // failure: the optimistic move is rolled back and the reason is shown
  await p.route('**/api/calendar/reschedule', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Something went wrong on our side' } }) }));
  await chip(from).dragTo(p.getByTestId(`cal-day-${to}`));
  await expect(p.getByText('Something went wrong on our side').first()).toBeVisible();
  await expect(chip(from)).toBeVisible(); await expect(chip(to)).toHaveCount(0);
  await p.unroute('**/api/calendar/reschedule');
  // success: moved immediately, saved on the server, same wall-clock time
  await chip(from).dragTo(p.getByTestId(`cal-day-${to}`));
  await toast(p, /Moved to/);
  await expect(chip(to)).toBeVisible();
  const saved = (await owner.get('/followups?view=pending')).data.find((f: { id: string }) => f.id === fu) as { dueAt: string };
  expect(key(new Date(saved.dueAt))).toBe(to);
  expect(new Date(saved.dueAt).toISOString().slice(11, 16)).toBe(due.toISOString().slice(11, 16));
  // accessible alternative: the reschedule button and dialog (fresh page: no toast competing for focus)
  await p.reload();
  const target = key(new Date(due.getTime() + 3 * 86_400_000));
  await chip(to).getByRole('button', { name: /^Reschedule / }).click({ force: true });
  const dlg = p.getByRole('dialog');
  await dlg.getByLabel('Date').fill(target);
  await dlg.getByRole('button', { name: 'Move' }).click();
  await toast(p, /Moved to/);
  await expect(chip(target)).toBeVisible();
  // a viewer sees the item but cannot move it
  const v = ws.people.VIEWER.page;
  await v.goto('/follow-ups?view=calendar');
  const vchip = v.getByTestId(`cal-event-followup-${fu}`);
  await expect(vchip).toBeVisible();
  await expect(vchip).toHaveAttribute('draggable', 'false');
  await expect(vchip.getByRole('button', { name: /^Reschedule / })).toHaveCount(0);
});

test('imports: large file runs in the background with progress, history and an error report', async () => {
  const p = ws.people.OWNER.page;
  const rows = ['First Name,Last Name,Email'];
  for (let i = 0; i < 620; i++) rows.push(`Bulk${i},Lead,bulk${i}-${ws.id.slice(0, 6)}@big.test`);
  rows.push('Broken,Row,not-an-email');
  await p.goto('/leads');
  await p.getByRole('button', { name: 'Import' }).click();
  await p.getByTestId('import-file').setInputFiles({ name: 'big.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
  await expect(p.getByRole('button', { name: /Start import \(621 rows\)/ })).toBeVisible();
  await p.getByRole('button', { name: /Start import/ }).click();
  await expect(p.getByText('Import complete')).toBeVisible({ timeout: 90_000 });
  await expect(p.getByTestId('import-status').getByText('Imported 620 leads')).toBeVisible();
  await p.getByRole('tab', { name: 'History' }).click();
  const hist = p.getByRole('list', { name: 'Import history' });
  await expect(hist.getByText('big.csv')).toBeVisible();
  await expect(hist.getByText(/620 created/)).toBeVisible();
  const dl = p.waitForEvent('download');
  await hist.getByRole('button', { name: /Error report/ }).first().click();
  expect((await dl).suggestedFilename()).toMatch(/errors\.csv$/);
});

test('single sign-on: configure, test, switch on, sign in through the identity provider', async ({ browser }) => {
  const idp = await new MockIdp().start();
  try {
    const owner = ws.people.OWNER, agent = ws.people.SALES_AGENT;
    const slug = (await api(owner, ws.id).get('/organizations/current')).data.organization.slug as string;
    const p = owner.page;
    await p.goto('/settings?tab=sso');
    await expect(p.getByTestId('sso-callback')).toHaveText(/\/api\/auth\/sso\/callback$/);
    await p.getByLabel('Display name').fill('E2E IdP');
    await p.getByLabel('Client ID').fill(idp.clientId);
    await p.getByLabel('Issuer URL').fill(idp.url);
    await p.getByLabel('Client secret').fill(idp.clientSecret);
    await p.getByLabel('Allowed email domains').fill('fx.test');
    await p.getByRole('button', { name: 'Check issuer' }).click();
    await expect(p.getByText(/Provider found/)).toBeVisible();
    await p.getByRole('button', { name: 'Save connection' }).click();
    await expect(p.getByText('Not tested yet')).toBeVisible();
    await expect(p.getByRole('button', { name: 'Switch SSO on' })).toBeDisabled();           // cannot be switched on before a successful test
    idp.claims = { sub: 'sub-owner', email: owner.email, email_verified: true, name: owner.name };
    await p.getByRole('button', { name: 'Test sign-in' }).click();
    await expect(p).toHaveURL(/sso_test=ok/, { timeout: 30_000 });
    await p.getByRole('button', { name: 'Switch SSO on' }).click();
    await expect(p.getByText('Enabled', { exact: true })).toBeVisible();
    // the agent signs out and comes back through the identity provider
    const a = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await a.newPage();
    idp.claims = { sub: 'sub-agent', email: agent.email, email_verified: true, name: agent.name };
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in with single sign-on' }).click();
    await page.getByLabel('Workspace name').fill(slug);
    await page.getByRole('button', { name: 'Continue with single sign-on' }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    await expect(page.getByText(agent.name).first()).toBeVisible();
    // an unknown workspace shows a clear message and still offers the password form
    await a.clearCookies(); await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in with single sign-on' }).click();
    await page.getByLabel('Workspace name').fill('no-such-workspace');
    await page.getByRole('button', { name: 'Continue with single sign-on' }).click();
    await expect(page.getByText(/Single sign-on is not enabled for that workspace/)).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await a.close();
    // clean up so later tests are unaffected
    await api(owner, ws.id).post('/sso/state', { enabled: false });
  } finally { await idp.stop(); }
});
