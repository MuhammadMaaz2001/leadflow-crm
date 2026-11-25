import { expect, test } from '@playwright/test';
import { login, toast, uniq } from './helpers';

test('lead management: search, filters, saved views, import with error report, bulk assign, export, duplicate merge', async ({ page }) => {
  const id = uniq();
  await login(page, 'manager@northwind.test', 'Demo#Pass2026', /dashboard/);

  await test.step('search and filter', async () => {
    await page.goto('/leads');
    await expect(page.getByRole('heading', { name: 'Leads' })).toBeVisible();
    await page.getByLabel('Search leads').fill('Daniel');
    await expect(page.getByRole('table').getByText('Daniel Ali')).toBeVisible();
    await expect(page).toHaveURL(/q=Daniel/);
    await page.getByLabel('Search leads').fill('');
    await page.getByLabel('Status filter').selectOption('CONVERTED');
    await expect(page).toHaveURL(/status=CONVERTED/);
    await expect.poll(async () => {
      const statuses = await page.getByRole('table').locator('tbody tr td:nth-child(4)').allTextContents();
      return statuses.length > 0 && statuses.every((s) => s.trim() === 'Won');
    }).toBe(true);
  });

  await test.step('saved views', async () => {
    await page.getByRole('button', { name: 'Views' }).click();
    await page.getByRole('menuitem', { name: /Save current filters/ }).click();
    await page.getByLabel('View name').fill(`Won deals ${id}`);
    await page.getByRole('button', { name: 'Save view' }).click();
    await toast(page, 'View saved');
    await page.goto('/leads');
    await page.getByRole('button', { name: 'Views' }).click();
    await page.getByRole('menuitem', { name: new RegExp(`Won deals ${id}`) }).click();
    await expect(page).toHaveURL(/status=CONVERTED/);
    await page.getByRole('button', { name: 'Views' }).click();
    await page.getByRole('button', { name: `Delete view Won deals ${id}` }).click();
    await page.keyboard.press('Escape');
  });

  const email = `import-${id}@csv.test`;
  await test.step('import: validation report, error CSV, then import valid rows', async () => {
    await page.goto('/leads');
    await page.getByRole('button', { name: 'Import' }).click();
    const csv = ['First Name,Last Name,Email,Phone,Company,Source,Priority', `Imported${id},Lead,${email},,CSV Co,Website,Hot`, 'Broken,Row,not-an-email,,,,', ',NoName,noname@csv.test,,,,'].join('\n');
    await page.getByTestId('import-file').setInputFiles({ name: 'leads.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.getByText('Rows needing attention')).toBeVisible();                    // preview of the uploaded file (job created, nothing imported yet)
    await expect(page.getByText(/Invalid email/)).toBeVisible();
    await expect(page.getByText('First name (or Name) is required')).toBeVisible();
    await page.getByRole('button', { name: /Start import \(3 rows\)/ }).click();            // now it runs as a background job
    await expect(page.getByText('Import complete')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('import-status').getByText('Imported 1 lead')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download error report/ }).click();
    expect((await download).suggestedFilename()).toMatch(/errors\.csv$/);
    await page.getByRole('button', { name: 'Done' }).click();
  });

  await test.step('bulk assign the imported lead', async () => {
    await page.getByLabel('Search leads').fill(`Imported${id}`);
    await expect(page.getByRole('table').getByText(`Imported${id} Lead`)).toBeVisible();
    await page.getByRole('table').getByRole('checkbox', { name: 'Select row' }).first().click();
    await expect(page.getByRole('region', { name: 'Bulk actions' })).toContainText('1 selected');
    await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Assign' }).click();
    await page.getByLabel('Assign to').selectOption({ label: 'Sara Ahmed' });
    await page.getByRole('button', { name: 'Assign', exact: true }).click();
    await toast(page, /Updated \d lead/);
    await expect(page.getByRole('table').getByText('Sara Ahmed')).toBeVisible();
  });

  await test.step('export current results as CSV', async () => {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export' }).click();
    await page.getByRole('menuitem', { name: 'CSV file' }).click();
    const d = await download;
    expect(d.suggestedFilename()).toMatch(/^leads-.*\.csv$/);
    const text = (await (await d.createReadStream()).toArray()).map((b) => b.toString()).join('');
    expect(text).toContain(email);
  });

  await test.step('duplicate detection on create, then merge from the duplicates dialog', async () => {
    await page.getByRole('button', { name: 'Add lead' }).click();
    await page.locator('#lf-first').fill('Twin');
    await page.locator('#lf-email').fill(email.toUpperCase());
    await page.locator('#lf-email').blur();
    await expect(page.getByText('Possible duplicate')).toBeVisible();
    await page.getByRole('button', { name: 'Create lead' }).click();
    await expect(page.getByText('already exists').first()).toBeVisible();
    await page.getByRole('button', { name: 'Create anyway' }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}/);
    await page.goto('/leads');
    await page.getByRole('button', { name: 'More lead tools' }).click();
    await page.getByRole('menuitem', { name: /Find & merge duplicates/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Duplicate leads' });
    const group = dlg.locator('div.rounded-xl').filter({ hasText: email });
    await expect(group.first()).toBeVisible();
    await group.getByRole('button', { name: 'Merge into selected' }).click();
    await page.getByRole('button', { name: 'Merge leads' }).click();
    await toast(page, 'Leads merged');
    await page.keyboard.press('Escape');
    await page.getByLabel('Search leads').fill(`${id}`);
    await expect(page.getByRole('table').getByText(`Imported${id} Lead`)).toBeVisible();
    await expect(page.getByRole('table').getByText('Twin')).toHaveCount(0);   // merged lead is archived, not listed
  });

  await test.step('cleanup: archive the test lead', async () => {
    await page.getByRole('table').getByRole('checkbox', { name: 'Select row' }).first().click();
    await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Archive' }).click();
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await toast(page, /Archived 1/);
  });
});
