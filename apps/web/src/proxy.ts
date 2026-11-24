import { NextResponse, type NextRequest } from 'next/server';

/**
 * Per-request Content-Security-Policy with a nonce (Next.js attaches the nonce to its own scripts/styles during
 * server rendering — see node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
 *  - script-src: only same-origin files and nonce'd scripts ('strict-dynamic' lets those load their chunks). No 'unsafe-inline'.
 *  - style-src: same-origin + inline styles (toast library injects <style>, charts / drag & drop / Radix set style attributes).
 *  - connect-src 'self': the browser only talks to the web origin (API calls are proxied through /api).
 *  - frame-ancestors 'none', object-src 'none', base-uri 'self', form-action 'self'.
 */
export function buildCsp(nonce: string, opts: { dev: boolean; upgradeInsecure: boolean }) {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ''}`,
    // Styles: sonner (toasts) injects a <style> element at runtime without a nonce, so style-src must allow 'unsafe-inline'.
    // This is the one deliberate relaxation: CSS cannot execute script (see PRODUCTION_READINESS.md).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(opts.upgradeInsecure ? ['upgrade-insecure-requests'] : []),
  ];
  return directives.join('; ');
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === 'development', upgradeInsecure: process.env.CSP_UPGRADE_INSECURE_REQUESTS === 'true' });
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [{ source: '/((?!api|_next/static|_next/image|favicon.ico).*)', missing: [{ type: 'header', key: 'next-router-prefetch' }, { type: 'header', key: 'purpose', value: 'prefetch' }] }],
};
