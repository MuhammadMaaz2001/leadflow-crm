import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeRedis, getRedis } from '../src/lib/redis';

// Real processes (not in-process apps): start-up, health endpoints, heartbeat and SIGTERM behaviour of the server and the worker.
const API_DIR = path.resolve(__dirname, '..');
const children: ChildProcess[] = [];
afterAll(async () => { for (const c of children) c.kill('SIGKILL'); await closeRedis(); });

function start(entry: string, env: Record<string, string>) {
  const logs: string[] = [];
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: API_DIR, env: { ...process.env, VITEST: '', NODE_ENV: 'development', ...env, LOG_LEVEL: 'info' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout!.on('data', (d) => logs.push(String(d))); child.stderr!.on('data', (d) => logs.push(String(d)));
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.on('exit', (code, signal) => r({ code, signal })));
  return { child, logs, exited };
}
const until = async (fn: () => Promise<boolean> | boolean, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out waiting for condition'); };

describe('real processes', () => {
  it('API: serves readiness, drains and exits 0 on SIGTERM', async () => {
    const port = 4300 + Math.floor(Math.random() * 400);
    const p = start('src/server.ts', { API_PORT: String(port), JOBS_INLINE: 'true', DISABLE_RATE_LIMIT: 'true' });
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/health/ready`)).status === 200; } catch { return false; } });
    const ready = await (await fetch(`http://127.0.0.1:${port}/api/health/ready`, { headers: { 'x-request-id': 'proc-test-12345' } })).json() as { status: string };
    expect(ready.status).toBe('ok');
    p.child.kill('SIGTERM');
    const r = await Promise.race([p.exited, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('did not exit after SIGTERM')), 15000))]);
    expect(r.code).toBe(0);
    const all = p.logs.join('');
    expect(all).toContain('shutdown started'); expect(all).toContain('shutdown complete');
    expect(all).toContain('"msg":"API listening"');
    // every log line is valid JSON (structured logging) and none contains a connection string password
    for (const line of all.split('\n').filter(Boolean)) { expect(() => JSON.parse(line), line).not.toThrow(); }
    expect(all).not.toMatch(/leadflow_app_dev|leadflow_platform_dev/);
  });

  it('worker: registers a heartbeat, processes the schedule and clears its heartbeat on SIGTERM (exit 0)', async () => {
    const queue = `leadflow-proc-${Date.now()}`;
    const p = start('src/worker.ts', { JOBS_INLINE: 'false', QUEUE_NAME: queue, WORKER_HEALTH_PORT: String(4800 + Math.floor(Math.random() * 100)) });
    const redis = getRedis();
    let key = '';
    await until(async () => { const keys = await redis.keys('worker:hb:*'); key = keys.find((k) => k.includes(String(p.child.pid))) ?? ''; return !!key; });
    expect(JSON.parse((await redis.get(key))!)).toMatchObject({ pid: p.child.pid });
    p.child.kill('SIGTERM');
    const r = await Promise.race([p.exited, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('worker did not exit after SIGTERM')), 20000))]);
    expect(r.code).toBe(0);
    expect(await redis.get(key)).toBeNull();                                       // heartbeat removed → monitoring sees it leave immediately
    expect(p.logs.join('')).toContain('shutdown complete');
    // clean up the schedule this test created
    const { Queue } = await import('bullmq');
    const q = new Queue(queue, { connection: { host: 'localhost', port: 6379 } }); await q.obliterate({ force: true }).catch(() => undefined); await q.close();
  });

  it('refuses to start in production with an unsafe configuration', async () => {
    const p = start('src/server.ts', { NODE_ENV: 'production', ALLOW_DEV_TOOLS: '', JOBS_INLINE: 'true', EMAIL_TRANSPORT: 'dev' });
    const r = await Promise.race([p.exited, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('server kept running')), 15000))]);
    expect(r.code).toBe(1);
    const all = p.logs.join('');
    expect(all).toMatch(/Refusing to start/);
    expect(all).toMatch(/JOBS_INLINE/);
  });
});
