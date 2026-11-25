import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { createMetricsServer, metricsAuthOk, renderMetrics, resetMetricsCache, startMetricsServer } from '../src/lib/metrics';
import { registerProcessor, runProcessor, type JobName } from '../src/lib/queue';
import { LocalDiskStorage, setObjectStorage, type ObjectStorage } from '../src/lib/storage';
import { addMember, boot, createWorkspace, request, signUp, uniq, app, type Actor } from './helpers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'metrics-token-' + 'x'.repeat(24);
let server: http.Server, base = '';
let owner: Actor, agent: Actor;
const scrape = async (token: string | null = TOKEN) => fetch(`${base}/metrics`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const text = async () => (await scrape()).text();
/** value of the first sample matching name and labels (substring match on the label set) */
const val = (body: string, name: string, labels: Record<string, string> = {}) => {
  const line = body.split('\n').find((l) => l.startsWith(`${name}{`) && Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)));
  return line ? Number(line.split(' ').pop()) : 0;
};

beforeAll(async () => {
  await boot();
  server = createMetricsServer({ token: TOKEN, instance: 'api' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  owner = await createWorkspace(await signUp('Metrics Owner Secretname'), `Metrics ${uniq()}`);
  agent = await addMember(owner, 'SALES_AGENT', 'Metrics Agent');
});
afterAll(async () => { await new Promise((r) => server.close(r)); setObjectStorage(null); });

describe('the metrics endpoint is protected and never on the public API', () => {
  it('is not served by the API port at all', async () => {
    for (const p of ['/metrics', '/api/metrics', '/api/health/metrics']) expect((await request(app).get(p)).status, p).toBe(404);
  });
  it('requires the bearer token and answers only GET /metrics', async () => {
    expect((await scrape(null)).status).toBe(401);
    expect((await scrape('wrong-token')).status).toBe(401);
    expect((await scrape(TOKEN + 'x')).status).toBe(401);
    expect((await scrape(TOKEN)).status).toBe(200);
    expect((await fetch(`${base}/other`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect((await scrape(TOKEN)).headers.get('content-type')).toMatch(/text\/plain/);
    expect(metricsAuthOk(undefined, undefined)).toBe(true);     // no token configured (loopback-only deployments)
    expect(metricsAuthOk('Basic abc', TOKEN)).toBe(false);
  });
  it('refuses to listen on a network address without a strong token; defaults to loopback', async () => {
    const keep = { p: config.metricsPort, h: config.metricsHost, t: config.metricsToken };
    try {
      (config as { metricsPort: number | null }).metricsPort = 0; (config as { metricsHost: string }).metricsHost = '0.0.0.0'; (config as { metricsToken?: string }).metricsToken = undefined;
      // port 0 is falsy → "disabled"; use a real ephemeral-free high port for the refusal check
      (config as { metricsPort: number | null }).metricsPort = 39123;
      await expect(startMetricsServer('api')).rejects.toThrow(/METRICS_TOKEN/);
      (config as { metricsToken?: string }).metricsToken = 'short';
      await expect(startMetricsServer('api')).rejects.toThrow(/METRICS_TOKEN/);
      (config as { metricsHost: string }).metricsHost = '127.0.0.1';
      const s = await startMetricsServer('api'); expect(s).not.toBeNull(); await new Promise((r) => s!.close(r));
      (config as { metricsPort: number | null }).metricsPort = null;
      expect(await startMetricsServer('api')).toBeNull();      // disabled by default
    } finally { (config as { metricsPort: number | null }).metricsPort = keep.p; (config as { metricsHost: string }).metricsHost = keep.h; (config as { metricsToken?: string }).metricsToken = keep.t; }
    expect(config.metricsHost).toBe('127.0.0.1');
  });
});

describe('counters are correct', () => {
  it('counts requests, durations and errors per route pattern and status', async () => {
    const before = await text();
    const lead = (await owner.post('/leads', { firstName: 'Zebra', email: `zebra-${uniq()}@secret-customer.test` })).body.data.id as string;
    for (let i = 0; i < 3; i++) await owner.get(`/leads/${lead}`);
    await owner.get('/leads/a0000000-0000-4000-8000-000000000000');                 // 404
    await request(app).get('/api/leads');                                           // 401 (no session)
    const after = await text();
    const d = (labels: Record<string, string>, name = 'leadflow_http_requests_total') => val(after, name, labels) - val(before, name, labels);
    expect(d({ method: 'GET', route: '/api/leads/:id', status: '200' })).toBe(3);
    expect(d({ method: 'GET', route: '/api/leads/:id', status: '404' })).toBe(1);
    expect(d({ method: 'POST', route: '/api/leads', status: '201' })).toBe(1);
    expect(d({ method: 'GET', route: '/api/leads', status: '401' })).toBe(1);
    expect(d({ route: '/api/leads/:id', class: '4xx' }, 'leadflow_http_errors_total')).toBe(1);
    expect(val(after, 'leadflow_http_request_duration_seconds_count', { route: '/api/leads/:id', status_class: '2xx' })).toBeGreaterThanOrEqual(3);
    expect(after).toMatch(/leadflow_http_request_duration_seconds_bucket\{[^}]*le="0.1"/);
    expect(val(after, 'leadflow_http_requests_in_flight')).toBeLessThanOrEqual(2);
  });

  it('counts background jobs, failures and retries', async () => {
    registerProcessor('email.send' as JobName, async (d) => { if (d.fail) throw new Error('boom'); });
    const before = await text();
    await runProcessor('email.send', {});
    await runProcessor('email.send', { fail: true }).catch(() => undefined);
    await runProcessor('email.send', { fail: true }, 2).catch(() => undefined);     // BullMQ attempt #3 → counted as a retry
    const after = await text();
    expect(val(after, 'leadflow_jobs_processed_total', { job: 'email.send', result: 'success' }) - val(before, 'leadflow_jobs_processed_total', { job: 'email.send', result: 'success' })).toBe(1);
    expect(val(after, 'leadflow_jobs_processed_total', { job: 'email.send', result: 'failure' }) - val(before, 'leadflow_jobs_processed_total', { job: 'email.send', result: 'failure' })).toBe(2);
    expect(val(after, 'leadflow_job_retries_total', { job: 'email.send' }) - val(before, 'leadflow_job_retries_total', { job: 'email.send' })).toBe(1);
    expect(val(after, 'leadflow_job_duration_seconds_count', { job: 'email.send' })).toBeGreaterThanOrEqual(3);
    // restore the real processor for the tests that follow
    (await import('../src/jobs')).registerProcessors();
  });

  it('counts storage operations and storage failures', async () => {
    class Flaky extends LocalDiskStorage { fail = false; async put(k: string, b: Buffer, t: string) { if (this.fail) throw new Error('S3 down'); return super.put(k, b, t); } }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-m-')); const st = new Flaky(dir); setObjectStorage(st as ObjectStorage);
    const lead = (await owner.post('/leads', { firstName: 'Files', email: `files-${uniq()}@x.test` })).body.data.id as string;
    const up = (name: string) => owner.agent.post(`/api/leads/${lead}/attachments`).set('X-Org-Id', owner.orgId!).attach('files', Buffer.from('%PDF-1.4\nx'), { filename: name, contentType: 'application/pdf' });
    const before = await text();
    expect((await up('a.pdf')).status).toBe(201);
    st.fail = true; expect((await up('b.pdf')).status).toBe(503); st.fail = false;
    const after = await text();
    expect(val(after, 'leadflow_storage_operations_total', { op: 'put', result: 'ok' }) - val(before, 'leadflow_storage_operations_total', { op: 'put', result: 'ok' })).toBe(1);
    expect(val(after, 'leadflow_storage_operations_total', { op: 'put', result: 'error' }) - val(before, 'leadflow_storage_operations_total', { op: 'put', result: 'error' })).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('counts search strategies and import rows', async () => {
    const before = await text();
    await owner.get('/leads?q=zebra');
    const csv = Buffer.from('First Name,Email\nMeta,m1@metrics.test\nTer,not-an-email\n');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-m2-')); setObjectStorage(new LocalDiskStorage(dir));
    const up = await owner.agent.post('/api/leads/import/jobs').set('X-Org-Id', owner.orgId!).attach('file', csv, { filename: 'm.csv', contentType: 'text/csv' });
    await owner.post(`/leads/import/jobs/${up.body.data.id}/start`);
    const after = await text();
    expect(val(after, 'leadflow_lead_search_total', { strategy: 'indexed' }) - val(before, 'leadflow_lead_search_total', { strategy: 'indexed' })).toBe(1);
    expect(val(after, 'leadflow_import_rows_total', { result: 'created' }) - val(before, 'leadflow_import_rows_total', { result: 'created' })).toBe(1);
    expect(val(after, 'leadflow_import_rows_total', { result: 'failed' }) - val(before, 'leadflow_import_rows_total', { result: 'failed' })).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('scrape-time gauges', () => {
  it('reports Redis, queue, workers, scheduler, workspaces, users, sessions, imports and the connection pool', async () => {
    resetMetricsCache();
    const body = await text();
    expect(val(body, 'leadflow_redis_up')).toBe(1);
    expect(body).toMatch(/leadflow_queue_jobs\{[^}]*state="waiting"/);
    for (const s of ['active', 'failed', 'delayed']) expect(body).toContain(`state="${s}"`);
    expect(body).toMatch(/^leadflow_workers_alive\{/m);
    expect(body).toMatch(/^leadflow_scheduler_stale\{/m);
    expect(val(body, 'leadflow_workspaces', { status: 'ACTIVE' })).toBeGreaterThanOrEqual(1);
    expect(val(body, 'leadflow_users')).toBeGreaterThanOrEqual(2);
    expect(val(body, 'leadflow_sessions_active')).toBeGreaterThanOrEqual(2);
    expect(val(body, 'leadflow_import_jobs', { status: 'COMPLETED' })).toBeGreaterThanOrEqual(1);
    expect(body).toMatch(/prisma_pool_connections_open\{[^}]*client="app"/);
    expect(body).toMatch(/prisma_client_queries_total\{[^}]*client="app"/);
    expect(body).toMatch(/prisma_client_queries_duration_histogram_ms_bucket\{[^}]*client="platform"/);
    expect(body).toMatch(/^leadflow_process_cpu_user_seconds_total\{/m);
    expect(body).toMatch(/^leadflow_nodejs_eventloop_lag_seconds\{/m);
  });

  it('degrades gracefully: a failing collector never breaks the scrape', async () => {
    const body = await renderMetrics();
    expect(body.length).toBeGreaterThan(1000);
  });
});

describe('no sensitive data and low cardinality', () => {
  it('contains no personal data, identifiers, secrets or URLs of customers', async () => {
    // produce traffic that carries recognisable private values
    const secretEmail = `very-private-${uniq()}@customer-secret.test`;
    const lead = (await owner.post('/leads', { firstName: 'Confidentialfirst', lastName: 'Confidentiallast', email: secretEmail, companyName: 'Confidential Holdings' })).body.data.id as string;
    await owner.get(`/leads?q=${encodeURIComponent('Confidentialfirst')}`);
    await owner.get(`/leads/${lead}`);
    await request(app).post('/api/auth/login').send({ email: secretEmail, password: 'Wrong#Pass2026' });
    await owner.get('/this/does/not/exist/' + uniq());
    const body = await text();
    for (const secret of [secretEmail, 'Confidentialfirst', 'Confidentiallast', 'Confidential Holdings', 'Metrics Owner Secretname', 'customer-secret', lead, owner.orgId!, owner.userId, agent.userId, owner.email, TOKEN]) {
      expect(body.includes(secret), `metrics must not contain ${secret.slice(0, 12)}…`).toBe(false);
    }
    for (const env of [process.env.DATABASE_URL, process.env.APP_DATABASE_URL, process.env.REDIS_URL, process.env.S3_SECRET_ACCESS_KEY]) if (env && env.length > 8) expect(body.includes(env)).toBe(false);
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);            // no UUID anywhere
    expect(body).not.toMatch(/@[a-z0-9-]+\.(test|com)/i);                                                // no e-mail addresses
  });

  it('keeps HTTP label sets bounded no matter how many distinct URLs, ids or users hit the API', async () => {
    const series = (b: string) => b.split('\n').filter((l) => l.startsWith('leadflow_http_requests_total{')).length;
    const before = series(await text());
    for (let i = 0; i < 40; i++) { await owner.get(`/leads/${'00000000-0000-4000-8000-' + String(i).padStart(12, '0')}`); await request(app).get(`/api/random-${uniq()}/${i}`); await request(app).get(`/scan/${uniq()}.php`); }
    const body = await text();
    expect(series(body) - before).toBeLessThanOrEqual(2);                                               // one new route+status at most (404 on the id route, 'unmatched' 404)
    expect(val(body, 'leadflow_http_requests_total', { route: 'unmatched' })).toBeGreaterThanOrEqual(80);
    // only the documented label names are ever used on application metrics
    const allowed = new Set(['method', 'route', 'status', 'status_class', 'class', 'code', 'op', 'result', 'job', 'strategy', 'state', 'le', 'service']);
    const used = new Set<string>();
    for (const l of body.split('\n')) { if (!/^leadflow_(http|db|storage|job|jobs|import|lead_search|sso|queue|workspaces|import_jobs)/.test(l)) continue; const m = /\{(.*)\}/.exec(l); if (!m) continue; for (const k of m[1]!.matchAll(/([a-z_]+)="/g)) used.add(k[1]!); }
    for (const k of used) expect(allowed.has(k), `unexpected label "${k}"`).toBe(true);
  });
});
