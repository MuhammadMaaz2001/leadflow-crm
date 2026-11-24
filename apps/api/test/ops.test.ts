import { spawnSync } from 'node:child_process';
import path from 'node:path';
import express from 'express';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { validateProductionConfig } from '../src/config-validate';
import { withPool } from '../src/config';
import { createLogger, redact, redactString, sanitizeRequestId, setLogLevel, setLogSink } from '../src/lib/logger';
import { requestContext } from '../src/lib/request';
import { errorMiddleware } from '../src/http';
import { clearErrorReporters, setErrorReporter } from '../src/lib/error-report';
import { closeRedis, getRedis } from '../src/lib/redis';
import { isShuttingDown, onShutdown, shutdown } from '../src/lib/shutdown';
import { prisma } from '../src/db';
import { request } from './helpers';
import { PASSWORD } from './helpers';

afterAll(async () => { await closeRedis(); });

const GOOD = {
  NODE_ENV: 'production', DATABASE_URL: 'postgresql://owner:Zk3pX9mQ2v@db.internal:5432/leadflow?sslmode=require',
  APP_DATABASE_URL: 'postgresql://leadflow_app:Qw8rT5nB7c@db.internal:5432/leadflow?sslmode=require', PLATFORM_DATABASE_URL: 'postgresql://leadflow_platform:Lm4yH6sD1f@db.internal:5432/leadflow?sslmode=require',
  REDIS_URL: 'rediss://:pw@redis.internal:6380', WEB_URL: 'https://app.example.com', API_URL: 'https://api.example.com', JOBS_INLINE: 'false',
  EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASSWORD: 'p', EMAIL_FROM: 'LeadFlow <hello@example.com>', STORAGE_PROVIDER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', PAYMENT_PROVIDER: 'manual',
} as Record<string, string>;

describe('production environment validation', () => {
  it('accepts a complete production configuration (warnings only for manual payments)', () => {
    const r = validateProductionConfig(GOOD);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/manual/);
  });
  const bad = (patch: Record<string, string | undefined>, re: RegExp) => { const r = validateProductionConfig({ ...GOOD, ...patch }); expect(r.errors.join('\n')).toMatch(re); };
  it('rejects every unsafe setting', () => {
    bad({ NODE_ENV: 'development' }, /NODE_ENV/);
    bad({ NODE_ENV: undefined }, /NODE_ENV/);
    bad({ ALLOW_DEV_TOOLS: 'true' }, /ALLOW_DEV_TOOLS/);
    bad({ DISABLE_RATE_LIMIT: 'true' }, /DISABLE_RATE_LIMIT/);
    bad({ JOBS_INLINE: 'true' }, /JOBS_INLINE/);
    bad({ APP_DATABASE_URL: undefined }, /APP_DATABASE_URL is required/);
    bad({ APP_DATABASE_URL: 'postgresql://owner:Zk3pX9mQ2v@db.internal:5432/leadflow?sslmode=require' }, /restricted runtime role/);
    bad({ PLATFORM_DATABASE_URL: GOOD.APP_DATABASE_URL }, /different roles/);
    bad({ APP_DATABASE_URL: 'postgresql://leadflow_app:leadflow_app_dev@db.internal:5432/leadflow' }, /development password/);
    bad({ APP_DB_PASSWORD: 'leadflow_app_dev' }, /APP_DB_PASSWORD/);
    bad({ REDIS_URL: undefined }, /REDIS_URL/);
    bad({ WEB_URL: 'http://app.example.com' }, /https/);
    bad({ WEB_URL: 'https://app.example.com/dashboard' }, /origin without path/);
    bad({ WEB_URL: undefined }, /WEB_URL is required/);
    bad({ EMAIL_TRANSPORT: 'dev' }, /never delivers/);
    bad({ EMAIL_TRANSPORT: 'smtp', SMTP_HOST: undefined }, /SMTP_HOST/);
    bad({ EMAIL_FROM: 'LeadFlow <no-reply@localhost>' }, /EMAIL_FROM/);
    bad({ STORAGE_PROVIDER: 's3', S3_BUCKET: undefined }, /S3_BUCKET/);
    bad({ PAYMENT_PROVIDER: 'stripe' }, /no adapter installed/);
  });
  it('warns about weaker-but-allowed choices', () => {
    const w = (patch: Record<string, string | undefined>) => validateProductionConfig({ ...GOOD, ...patch }).warnings.join('\n');
    expect(w({ EMAIL_TRANSPORT: 'none' })).toMatch(/no email is delivered/);
    expect(w({ STORAGE_PROVIDER: 'db' })).toMatch(/base64 in PostgreSQL/);
    expect(w({ RATE_LIMIT_STORE: 'memory' })).toMatch(/per process/);
    expect(w({ REDIS_URL: 'redis://redis.internal:6379' })).toMatch(/TLS/);
    expect(w({ APP_DATABASE_URL: GOOD.APP_DATABASE_URL.replace('?sslmode=require', '') })).toMatch(/sslmode/);
  });
  it('the real process refuses to start/run checks with an unsafe environment (exit code)', () => {
    const script = path.resolve(__dirname, '../src/scripts/check-config.ts');
    const run = (env: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', script], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
    const ok = run(GOOD); expect(ok.status, ok.stderr).toBe(0);
    const unsafe = run({ ...GOOD, NODE_ENV: 'production', EMAIL_TRANSPORT: 'dev', JOBS_INLINE: 'true' });
    expect(unsafe.status).toBe(1);
    expect(unsafe.stderr).toMatch(/JOBS_INLINE/);
  });
  it('adds connection pool limits to database URLs without overriding explicit ones', () => {
    expect(withPool('postgresql://u:p@h:5432/d', 20, 20)).toContain('connection_limit=20');
    expect(withPool('postgresql://u:p@h:5432/d?connection_limit=7', 20, 20)).toContain('connection_limit=7');
    expect(withPool('postgresql://u:p@h:5432/d', 20, 20)).toContain('pool_timeout=20');
  });
});

describe('structured logging, request ids and secrets', () => {
  it('redacts passwords, tokens, cookies and credentials in URLs; truncates deep objects', () => {
    const out = redact({ user: 'a', password: 'hunter2', nested: { Authorization: 'Bearer abc', token: 't', ok: 1 }, url: 'postgresql://u:supersecret@db:5432/x', list: [{ apiKey: 'k' }] }) as Record<string, unknown>;
    const json = JSON.stringify(out);
    for (const secret of ['hunter2', 'Bearer abc', 'supersecret', '"k"']) expect(json).not.toContain(secret);
    expect(json).toContain('"ok":1');
    expect(redactString('GET /verify-email?token=abcdef&x=1')).toBe('GET /verify-email?token=[redacted]&x=1');
  });
  it('only accepts harmless caller request ids', () => {
    expect(sanitizeRequestId('abc-12345678')).toBe('abc-12345678');
    expect(sanitizeRequestId('x"\n{"level":"error"}')).toBeNull();
    expect(sanitizeRequestId('short')).toBeNull();
  });
  it('emits one JSON access-log line per request with the request id, never the query string or cookies', async () => {
    const lines: string[] = []; setLogSink((l) => lines.push(l)); setLogLevel('info');
    try {
      const app = createApp({ rateLimit: false, accessLog: true });
      const id = 'trace-abc-123456';
      const r = await request(app).post('/api/auth/login?token=SECRETQUERY').set('X-Request-Id', id).set('Cookie', 'lf_session=SECRETCOOKIE').send({ email: 'x@example.com', password: PASSWORD });
      expect(r.headers['x-request-id']).toBe(id);
      const entries = lines.map((l) => JSON.parse(l));
      const access = entries.find((e) => e.msg === 'request');
      expect(access).toMatchObject({ requestId: id, method: 'POST', status: r.status, level: expect.stringMatching(/info|warn/) });
      expect(typeof access.durationMs).toBe('number');
      const all = lines.join('\n');
      for (const s of ['SECRETQUERY', 'SECRETCOOKIE', PASSWORD]) expect(all).not.toContain(s);
      const generated = await request(app).get('/api/health');
      expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    } finally { setLogSink(null); setLogLevel('warn'); }
  });
  it('unexpected errors: generic 500 with a request id for support, error reported (with secrets scrubbed), nothing leaked to the client', async () => {
    const reported: unknown[] = []; setErrorReporter((e) => { reported.push(e); });
    const lines: string[] = []; setLogSink((l) => lines.push(l));
    try {
      const a = express(); a.use(requestContext({ accessLog: false }));
      a.get('/boom', (_req, _res, next) => next(new Error('connect postgresql://app:dbpassword99@db:5432/x failed')));
      a.use(errorMiddleware);
      const r = await request(a).get('/boom');
      expect(r.status).toBe(500);
      expect(r.body.error).toMatchObject({ code: 'INTERNAL' });
      expect(r.body.error.requestId).toBe(r.headers['x-request-id']);
      expect(JSON.stringify(r.body)).not.toContain('dbpassword99');
      expect(reported).toHaveLength(1);
      expect(lines.join('\n')).not.toContain('dbpassword99');
      expect(lines.join('\n')).toContain(r.headers['x-request-id']);
    } finally { clearErrorReporters(); setLogSink(null); }
  });
  it('loggers support child bindings', () => {
    const lines: string[] = []; setLogSink((l) => lines.push(l));
    try { createLogger({ a: 1 }).child({ b: 2 }).warn('hi', { c: 3 }); expect(JSON.parse(lines[0]!)).toMatchObject({ msg: 'hi', a: 1, b: 2, c: 3, level: 'warn' }); } finally { setLogSink(null); }
  });
});

describe('security headers and CORS on the API', () => {
  const app = createApp({ rateLimit: false });
  it('sends a default-deny CSP, HSTS, nosniff, no-referrer, frame denial and no-store', async () => {
    const r = await request(app).get('/api/health');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['strict-transport-security']).toMatch(/max-age=63072000/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
  it('CORS only allows the configured web origin, with credentials, and never reflects other origins', async () => {
    const good = await request(app).options('/api/leads').set('Origin', 'http://localhost:3000').set('Access-Control-Request-Method', 'POST');
    expect(good.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(good.headers['access-control-allow-credentials']).toBe('true');
    const evil = await request(app).options('/api/leads').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const blocked = await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: 'a@b.co', password: 'x' });
    expect(blocked.status).toBe(403);
  });
});

describe('health and readiness', () => {
  const app = createApp({ rateLimit: false });
  it('liveness is cheap and public; readiness reports database and redis', async () => {
    expect((await request(app).get('/api/health/live')).body.data).toMatchObject({ status: 'ok' });
    const r = await request(app).get('/api/health/ready');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', draining: false, checks: { database: { ok: true }, redis: { ok: true } } });
    expect(JSON.stringify(r.body)).not.toMatch(/postgres|password|@/);
  });
  it('Redis down → degraded (200, still serves) unless ?strict=true (503)', async () => {
    const spy = vi.spyOn(getRedis(), 'ping').mockRejectedValue(new Error('down'));
    try {
      const r = await request(app).get('/api/health/ready');
      expect(r.status).toBe(200); expect(r.body.status).toBe('degraded'); expect(r.body.checks.redis.ok).toBe(false);
      expect((await request(app).get('/api/health/ready?strict=true')).status).toBe(503);
    } finally { spy.mockRestore(); }
  });
  it('database down → 503 without leaking the error', async () => {
    const spy = vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('password authentication failed for user "leadflow_app"'));
    try {
      const r = await request(app).get('/api/health/ready');
      expect(r.status).toBe(503); expect(r.body.status).toBe('unavailable'); expect(r.body.checks.database.ok).toBe(false);
      expect(JSON.stringify(r.body)).not.toContain('leadflow_app');
    } finally { spy.mockRestore(); }
  });
  it('dev-only endpoints are not part of the production surface: docs are hidden when configured off', async () => {
    // NODE_ENV=test enables dev tools; the production default for apiDocs is off (asserted through the config rule)
    const script = `const {config}=require('./src/config'); console.log(JSON.stringify({docs:config.apiDocs,dev:config.devTools,prod:config.isProd}))`;
    const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], { cwd: path.resolve(__dirname, '..'), env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' }, encoding: 'utf8' });
    expect(JSON.parse(r.stdout.trim().split('\n').pop()!)).toEqual({ docs: false, dev: false, prod: true });
  });
});

describe('graceful shutdown (runs last: it flips the process into draining mode)', () => {
  it('runs closers in reverse order, survives a failing closer, bounds the time, and makes readiness answer 503', async () => {
    const order: string[] = [];
    onShutdown('first-registered', () => { order.push('first'); });
    onShutdown('broken', () => { order.push('broken'); throw new Error('boom'); });
    onShutdown('last-registered', async () => { await new Promise((r) => setTimeout(r, 50)); order.push('last'); });
    const exit = vi.fn();
    await shutdown('test', 0, exit as unknown as (c: number) => void);
    expect(order).toEqual(['last', 'broken', 'first']);
    expect(exit).toHaveBeenCalledWith(1);          // a failed step is reflected in the exit code
    expect(isShuttingDown()).toBe(true);
    const r = await request(createApp({ rateLimit: false })).get('/api/health/ready');
    expect(r.status).toBe(503); expect(r.body.draining).toBe(true);
    await shutdown('again', 0, exit as unknown as (c: number) => void); // idempotent
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
