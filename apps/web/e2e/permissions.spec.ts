import { expect, test } from '@playwright/test';
import { login } from './helpers';

test('sales agent sees only permitted navigation and own data; restricted pages show a clear message', async ({ page }) => {
  await login(page, 'sara@northwind.test', 'Demo#Pass2026', /dashboard/);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Leads' })).toBeVisible();
  for (const hidden of ['Subscription & Billing', 'Workspace Settings', 'Automations']) await expect(nav.getByRole('link', { name: hidden })).toHaveCount(0);
  await expect(page.getByText('Showing your own leads and follow-ups.')).toBeVisible();
  await page.goto('/billing');
  await expect(page.getByText("You don't have access to this page")).toBeVisible();
  await page.goto('/settings');
  await expect(page.getByText("You don't have access to this page")).toBeVisible();
  // leads list is restricted to own leads
  await page.goto('/leads');
  const own = await page.locator('h1 span').first().textContent();
  expect(Number(own)).toBeGreaterThan(0);
  expect(Number(own)).toBeLessThan(42);
  // API refuses even if the UI were bypassed
  const orgId = await page.evaluate(() => localStorage.getItem('lf_org'));
  const r = await page.request.get('http://localhost:4000/api/billing', { headers: { 'X-Org-Id': orgId! } });
  expect(r.status()).toBe(403);
});

test('owner can see billing and settings', async ({ page }) => {
  await login(page, 'owner@northwind.test', 'Demo#Pass2026', /dashboard/);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Subscription & Billing' })).toBeVisible();
  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: 'Subscription & billing' })).toBeVisible();
  await expect(page.getByText('Professional').first()).toBeVisible();
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible();
  await page.getByRole('tab', { name: 'Pipelines' }).click();
  await expect(page.getByLabel('Name of stage 1')).toHaveValue('New');
});
