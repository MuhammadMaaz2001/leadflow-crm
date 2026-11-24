import { expect, test } from '@playwright/test';
import { login } from './helpers';

const ROUTES = ['/dashboard', '/leads', '/pipeline', '/opportunities', '/follow-ups', '/tasks', '/team', '/reports', '/activity', '/automations', '/billing', '/settings', '/notifications', '/profile'];

test('Content-Security-Policy: strict nonce policy, no violations on any screen, injected inline script cannot run', async ({ page }) => {
  const violations: string[] = [];
  page.on('pageerror', (e) => { if (/Content Security Policy/i.test(e.message)) violations.push(e.message.slice(0, 200)); });

  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} | ${e.blockedURI} | ${(e.sample || '').slice(0, 80)} | ${e.sourceFile}:${e.lineNumber}`));
  });
  const loginResp = page.waitForResponse((r) => r.url().endsWith('/login') && r.request().resourceType() === 'document');
  await page.goto('/login');
  const csp = (await (await loginResp).allHeaders())['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("object-src 'none'");
  // nonce differs on every request
  const nonceOf = (h: string) => /'nonce-([^']+)'/.exec(h)?.[1];
  const second = await page.request.get('/login');
  expect(nonceOf(second.headers()['content-security-policy'] ?? '')).not.toBe(nonceOf(csp));

  await login(page, 'owner@northwind.test', 'Demo#Pass2026', /\/dashboard/);
  for (const route of ROUTES) {
    await page.goto(route);
    await expect(page.locator('main, #main').first()).toBeVisible();
    await page.waitForLoadState('networkidle').catch(() => undefined);
    for (const v of await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)) violations.push(`${route} :: ${v}`);
  }
  expect(violations, violations.join('\n')).toEqual([]);

  // Markup an attacker manages to inject (stored/reflected XSS) is parsed by the browser WITHOUT our nonce: inline <script> must not run.
  // (A srcdoc frame inherits the page policy and parses its content like server-rendered HTML would be.)
  const ran = await page.evaluate(() => new Promise<boolean>((resolve) => {
    (window as unknown as { __xss: boolean }).__xss = false;
    const f = document.createElement('iframe');
    f.srcdoc = '<script>parent.__xss = true</script>';
    document.body.appendChild(f);
    setTimeout(() => resolve((window as unknown as { __xss: boolean }).__xss), 400);
  }));
  expect(ran).toBe(false);
  // …and so must an inline event handler injected as markup
  const handlerRan = await page.evaluate(() => new Promise<boolean>((resolve) => {
    (window as unknown as { __h: boolean }).__h = false;
    const d = document.createElement('div');
    d.innerHTML = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onload="window.__h = true">';
    document.body.appendChild(d);
    setTimeout(() => resolve((window as unknown as { __h: boolean }).__h), 300);
  }));
  expect(handlerRan).toBe(false);
});

test('security headers on the web origin; session cookie is httpOnly + SameSite; API errors never leak internals', async ({ page, request }) => {
  const r = await request.get('/login');
  const h = r.headers();
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(h['permissions-policy']).toContain('camera=()');
  expect(h['strict-transport-security']).toContain('max-age=');
  expect(h['x-powered-by']).toBeUndefined();
  await login(page, 'owner@northwind.test', 'Demo#Pass2026', /\/dashboard/);
  const cookie = (await page.context().cookies()).find((c) => c.name === 'lf_session')!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Lax');
  // the session token is not reachable from page scripts and not stored in web storage
  expect(await page.evaluate(() => document.cookie)).not.toContain('lf_session');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/session|token|password/i);
  const bad = await page.request.get('/api/leads/not-a-uuid');
  expect(JSON.stringify(await bad.json())).not.toMatch(/prisma|postgres|stack|at .*\.ts/i);
});
