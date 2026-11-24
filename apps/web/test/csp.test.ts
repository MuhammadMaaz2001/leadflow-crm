import { describe, expect, it } from 'vitest';
import { buildCsp } from '@/proxy';

describe('Content-Security-Policy', () => {
  const csp = buildCsp('abc123', { dev: false, upgradeInsecure: true });
  const dir = (name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';
  it('allows scripts only from self and the per-request nonce — never inline or eval', () => {
    expect(dir('script-src')).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
  });
  it('locks down framing, plugins, base URI, forms and network targets', () => {
    expect(dir('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(dir('object-src')).toBe("object-src 'none'");
    expect(dir('base-uri')).toBe("base-uri 'self'");
    expect(dir('form-action')).toBe("form-action 'self'");
    expect(dir('connect-src')).toBe("connect-src 'self'");
    expect(dir('default-src')).toBe("default-src 'self'");
    expect(csp).toContain('upgrade-insecure-requests');
  });
  it('only development may use eval (React debugging) and upgrade-insecure-requests is opt-in', () => {
    const dev = buildCsp('n', { dev: true, upgradeInsecure: false });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).not.toContain('upgrade-insecure-requests');
  });
  it('uses a different nonce per call', () => {
    expect(buildCsp('a', { dev: false, upgradeInsecure: false })).not.toBe(buildCsp('b', { dev: false, upgradeInsecure: false }));
  });
});
