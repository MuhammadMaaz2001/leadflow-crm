import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const PASSWORD = 'E2e#Passw0rd';
export const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
export const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function newUser(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  return { ctx, page: await ctx.newPage() };
}

export async function register(page: Page, name: string, email: string) {
  await page.goto('/register');
  await page.locator('#name').fill(name);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  // Documented development verification flow: the dev mailbox link shown on screen.
  await page.getByRole('link', { name: /Verify my email now/ }).click();
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
}

export async function login(page: Page, email: string, password = PASSWORD, expectUrl: RegExp = /\/(dashboard|onboarding|platform)/) {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(expectUrl);
}

/** Opens the invitation link from the dev mailbox and returns its token URL. */
export async function inviteLinkFor(page: Page, email: string): Promise<string> {
  await page.goto(`/dev/mailbox?email=${encodeURIComponent(email)}`);
  const link = page.locator('a[href*="/accept-invite?token="]').first();
  await expect(link).toBeVisible({ timeout: 20_000 });
  return (await link.getAttribute('href'))!;
}

export async function toast(page: Page, text: string | RegExp) {
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: text }).first()).toBeVisible();
}

/** local datetime-local string N minutes from now */
export function localIn(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
