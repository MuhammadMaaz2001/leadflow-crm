import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('mobile layout: drawer navigation, card lists, no horizontal scroll', async ({ page }) => {
  await login(page, 'manager@northwind.test', 'Demo#Pass2026', /dashboard/);
  const noOverflow = async (label: string) => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over, `${label} overflows horizontally by ${over}px`).toBeLessThanOrEqual(1);
  };
  await expect(page.getByText('Total leads').first()).toBeVisible();
  await noOverflow('dashboard');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: 'Leads' }).click();
  await expect(page).toHaveURL(/\/leads/);
  await expect(page.getByRole('heading', { name: 'Leads' })).toBeVisible();
  await expect(page.locator('ul.divide-y li').first()).toBeVisible();   // table collapses into stacked cards
  await noOverflow('leads');
  for (const path of ['/follow-ups', '/tasks', '/opportunities', '/reports', '/team', '/billing']) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await noOverflow(path);
  }
  await page.goto('/pipeline');
  await expect(page.getByTestId('kanban')).toBeVisible();
});

test('tablet layout renders the table and collapsible sidebar', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();
  await login(page, 'manager@northwind.test', 'Demo#Pass2026', /dashboard/);
  await page.goto('/leads');
  await expect(page.getByRole('columnheader', { name: /Lead/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await ctx.close();
});
