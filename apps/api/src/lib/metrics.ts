import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import client from 'prom-client';
import { config } from '../config';
import { log } from './logger';

/**
 * Prometheus metrics. DESIGN RULES (see ARCHITECTURE.md → Metrics):
 *  • never exposed on the public API port: a separate listener (METRICS_PORT / WORKER_METRICS_PORT), loopback by default, optional bearer token
 *    (REQUIRED when bound to a non-loopback address — the server refuses to start otherwise);
 *  • low cardinality only: labels are bounded enums (method, ROUTE PATTERN such as /api/leads/:id, status code, job name, queue state) —
 *    never user ids, workspace ids, emails, search terms, file names or raw URLs;
 *  • only counts, durations and states — no tenant data, no secrets;
 *  • collection is cheap: counters/histograms are updated in memory; the gauges that need I/O (queue, Redis, workers, database counts)
 *    are computed at scrape time with short timeouts, and the database-backed ones are cached for 30 s.
 */
export const registry = new client.Registry();
registry.setDefaultLabels({ service: config.serviceName });
client.collectDefaultMetrics({ register: registry, prefix: 'leadflow_' });

const ENABLED = true;
export const httpRequests = new client.Counter({ name: 'leadflow_http_requests_total', help: 'HTTP requests handled, by route pattern and status code', labelNames: ['method', 'route', 'status'] as const, registers: [registry] });
export const httpDuration = new client.Histogram({ name: 'leadflow_http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['method', 'route', 'status_class'] as const, buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry] });
export const httpInFlight = new client.Gauge({ name: 'leadflow_http_requests_in_flight', help: 'Requests currently being processed', registers: [registry] });
export const httpErrors = new client.Counter({ name: 'leadflow_http_errors_total', help: 'Responses with status >= 400, by route pattern and class (4xx / 5xx)', labelNames: ['route', 'class'] as const, registers: [registry] });
export const dbErrors = new client.Counter({ name: 'leadflow_db_errors_total', help: 'Database errors surfaced to a request or job, by Prisma/Postgres error code', labelNames: ['code'] as const, registers: [registry] });
export const storageOps = new client.Counter({ name: 'leadflow_storage_operations_total', help: 'Object storage operations', labelNames: ['op', 'result'] as const, registers: [registry] });
export const storageDuration = new client.Histogram({ name: 'leadflow_storage_operation_duration_seconds', help: 'Object storage operation duration', labelNames: ['op'] as const, buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry] });
export const jobsProcessed = new client.Counter({ name: 'leadflow_jobs_processed_total', help: 'Background jobs processed, by job and result', labelNames: ['job', 'result'] as const, registers: [registry] });
export const jobDuration = new client.Histogram({ name: 'leadflow_job_duration_seconds', help: 'Background job duration', labelNames: ['job'] as const, buckets: [0.01, 0.05, 0.25, 1, 5, 15, 60, 300], registers: [registry] });
export const jobRetries = new client.Counter({ name: 'leadflow_job_retries_total', help: 'Job attempts beyond the first (retries)', labelNames: ['job'] as const, registers: [registry] });
export const importRows = new client.Counter({ name: 'leadflow_import_rows_total', help: 'Rows processed by background imports, by outcome', labelNames: ['result'] as const, registers: [registry] });
export const importBatchDuration = new client.Histogram({ name: 'leadflow_import_batch_duration_seconds', help: 'Duration of one committed import batch', buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15], registers: [registry] });
export const searchPlans = new client.Counter({ name: 'leadflow_lead_search_total', help: 'Lead searches by strategy (indexed = trigram id list, broad = ILIKE fallback)', labelNames: ['strategy'] as const, registers: [registry] });
export const ssoLogins = new client.Counter({ name: 'leadflow_sso_logins_total', help: 'SSO sign-in attempts by outcome', labelNames: ['result'] as const, registers: [registry] });

type Collector = () => Promise<void>;
const collectors: Collector[] = [];
/** Registers a gauge whose value needs I/O; `collect` runs at scrape time (with a short timeout) and only the scraping process pays for it. */
export function scrapeGauge(name: string, help: string, labelNames: string[], fill: (g: client.Gauge<string>) => Promise<void>) {
  const g = new client.Gauge({ name, help, labelNames, registers: [registry] });
  collectors.push(async () => { g.reset(); await fill(g); });
  return g;
}
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// ── gauges computed at scrape time ──
scrapeGauge('leadflow_redis_up', '1 when Redis answers PING', [], async (g) => {
  const { checkRedis } = await import('./health');
  const r = await checkRedis(); g.set(r.ok ? 1 : 0);
});
scrapeGauge('leadflow_queue_jobs', 'Jobs in the BullMQ queue by state (cluster-wide: every instance reports the same numbers — use max())', ['state'], async (g) => {
  const { queueCounts } = await import('./queue');
  const c = await queueCounts();
  for (const [state, n] of Object.entries(c)) g.set({ state }, Number(n));
});
scrapeGauge('leadflow_workers_alive', 'Worker processes with a fresh heartbeat (cluster-wide)', [], async (g) => { const { workerStatus } = await import('./health'); g.set((await workerStatus()).workers); });
scrapeGauge('leadflow_scheduler_last_run_age_seconds', 'Seconds since the scheduler last completed a tick (cluster-wide)', [], async (g) => {
  const { workerStatus } = await import('./health'); const s = await workerStatus(); if (s.schedulerAgeSeconds !== null) g.set(s.schedulerAgeSeconds);
});
scrapeGauge('leadflow_scheduler_stale', '1 when the scheduler has not ticked for 3 minutes (or never)', [], async (g) => { const { workerStatus } = await import('./health'); g.set((await workerStatus()).schedulerStale ? 1 : 0); });

let dbCache: { at: number; ws: Array<{ status: string; n: number }>; leads: number; users: number; sessions: number; imports: Array<{ status: string; n: number }> } | null = null;
async function dbFacts() {
  if (dbCache && Date.now() - dbCache.at < 30_000) return dbCache;
  const { platformPrisma } = await import('../db');
  // Only the platform role is used: it can read organisations / users / sessions / usage snapshots and the STATUS column of imports — never CRM rows.
  const [ws, leads, users, sessions, imports] = await Promise.all([
    platformPrisma.$queryRaw<Array<{ status: string; n: bigint }>>`SELECT status::text AS status, count(*) AS n FROM organizations GROUP BY 1`,
    platformPrisma.$queryRaw<Array<{ n: bigint | null }>>`SELECT sum(leads) AS n FROM (SELECT DISTINCT ON (organization_id) leads FROM usage_records ORDER BY organization_id, day DESC) s`,
    platformPrisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM users WHERE is_active`,
    platformPrisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > now()`,
    platformPrisma.$queryRaw<Array<{ status: string; n: bigint }>>`SELECT status, count(*) AS n FROM import_jobs GROUP BY 1`,
  ]);
  dbCache = { at: Date.now(), ws: ws.map((r) => ({ status: r.status, n: Number(r.n) })), leads: Number(leads[0]?.n ?? 0), users: Number(users[0]?.n ?? 0), sessions: Number(sessions[0]?.n ?? 0), imports: imports.map((r) => ({ status: r.status, n: Number(r.n) })) };
  return dbCache;
}
export const resetMetricsCache = () => { dbCache = null; };
scrapeGauge('leadflow_workspaces', 'Workspaces by status', ['status'], async (g) => { for (const r of (await dbFacts()).ws) g.set({ status: r.status }, r.n); });
scrapeGauge('leadflow_leads', 'Leads across all workspaces as of the latest daily usage snapshot per workspace (approximate)', [], async (g) => { g.set((await dbFacts()).leads); });
scrapeGauge('leadflow_users', 'Active user accounts', [], async (g) => { g.set((await dbFacts()).users); });
scrapeGauge('leadflow_sessions_active', 'Unexpired, unrevoked sessions (a count only — no identities)', [], async (g) => { g.set((await dbFacts()).sessions); });
scrapeGauge('leadflow_import_jobs', 'Import jobs by status (all workspaces, last 90 days of history)', ['status'], async (g) => { for (const r of (await dbFacts()).imports) g.set({ status: r.status }, r.n); });

/** Prometheus text: application metrics + Prisma's own (query counts / durations, connection-pool gauges) for both database clients. */
export async function renderMetrics(): Promise<string> {
  await Promise.all(collectors.map((c) => withTimeout(c(), 3000).catch((e) => log.debug('metric collector failed', { error: (e as Error).message }))));
  let out = await registry.metrics();
  try {
    const { prisma, platformPrisma } = await import('../db');
    for (const [name, c] of [['app', prisma], ['platform', platformPrisma]] as const) {
      const text = await (c as unknown as { $metrics: { prometheus: (o: { globalLabels: Record<string, string> }) => Promise<string> } }).$metrics.prometheus({ globalLabels: { client: name } });
      out += `\n${text}`;
    }
  } catch (e) { log.debug('prisma metrics unavailable', { error: (e as Error).message }); }
  return out;
}

// ── HTTP instrumentation ──
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Route PATTERN (never the concrete URL): `/api/leads/:id`. Unmatched requests (scanners, typos) collapse into one label. */
export function routeLabel(req: Request): string {
  const set = (req.res?.locals as { routePattern?: string } | undefined)?.routePattern;
  if (set) return set.replace(UUID, ':id').slice(0, 120);
  if (!req.route?.path) return 'unmatched';
  return `${req.baseUrl || '/api'}${req.route.path}`.replace(UUID, ':id').slice(0, 120);
}
export function httpMetrics(req: Request, res: Response, next: NextFunction) {
  if (!ENABLED) return next();
  const end = httpDuration.startTimer();
  httpInFlight.inc();
  res.on('finish', () => {
    httpInFlight.dec();
    const route = routeLabel(req), status = String(res.statusCode), cls = `${status[0]}xx`;
    httpRequests.inc({ method: req.method, route, status });
    end({ method: req.method, route, status_class: cls });
    if (res.statusCode >= 400) httpErrors.inc({ route, class: cls });
  });
  res.on('close', () => { if (!res.writableFinished) httpInFlight.dec(); });
  next();
}

// ── scrape endpoint (separate listener) ──
const loopback = (h: string) => h === '127.0.0.1' || h === '::1' || h === 'localhost';
const digest = (s: string) => createHash('sha256').update(s).digest();
export function metricsAuthOk(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  const given = header?.startsWith('Bearer ') ? header.slice(7) : '';
  return timingSafeEqual(digest(given), digest(token));
}
export function createMetricsServer(opts: { token?: string; instance: string }) {
  return http.createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' || path !== '/metrics') { res.writeHead(404).end(); return; }
    if (!metricsAuthOk(req.headers.authorization, opts.token)) { res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="metrics"' }).end(); return; }
    try {
      const body = await renderMetrics();
      res.writeHead(200, { 'Content-Type': registry.contentType, 'Cache-Control': 'no-store' }).end(body);
    } catch (e) { log.warn('metrics scrape failed', { instance: opts.instance, error: (e as Error).message }); res.writeHead(500).end(); }
  });
}
/** Starts the scrape listener when a port is configured. Refuses an unauthenticated listener on a non-loopback address. */
export async function startMetricsServer(instance: 'api' | 'worker'): Promise<http.Server | null> {
  const port = instance === 'api' ? config.metricsPort : config.workerMetricsPort;
  if (!port) return null;
  if (!loopback(config.metricsHost) && (config.metricsToken?.length ?? 0) < 24) throw new Error('METRICS_HOST is not a loopback address: set METRICS_TOKEN (at least 24 characters) so the metrics endpoint is not open to the network.');
  const server = createMetricsServer({ token: config.metricsToken, instance });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, config.metricsHost, resolve); });
  log.info('metrics endpoint listening', { instance, host: config.metricsHost, port, auth: config.metricsToken ? 'bearer token' : 'none (loopback only)' });
  return server;
}
