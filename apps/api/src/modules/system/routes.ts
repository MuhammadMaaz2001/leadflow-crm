import { z } from 'zod';
import { db } from '../../db';
import { config } from '../../config';
import { forbidden } from '../../lib/errors';
import { defineRoutes, Reply } from '../../http';
import { checkDatabase, checkRedis } from '../../lib/health';
import { isShuttingDown } from '../../lib/shutdown';

export const system = defineRoutes('System', '');

system.get('/health', { auth: 'public', summary: 'Liveness probe' }, async () => ({ status: 'ok', time: new Date().toISOString() }));
system.get('/health/live', { auth: 'public', summary: 'Liveness probe (process is up)' }, async () => ({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) }));
/**
 * Readiness: 200 when this instance can serve traffic, 503 when it must be taken out of rotation.
 * PostgreSQL is required. Redis being down is reported as "degraded" (rate limits fall back to per-process, jobs are delayed)
 * and still 200, unless ?strict=true. While the process is shutting down it answers 503 so load balancers drain it first.
 */
system.get('/health/ready', { auth: 'public', query: z.object({ strict: z.enum(['true', 'false']).optional() }), summary: 'Readiness probe (database + redis)' }, async ({ query }) => {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const draining = isShuttingDown();
  const ready = database.ok && !draining && (query.strict !== 'true' || redis.ok);
  const status = !ready ? 'unavailable' : redis.ok ? 'ok' : 'degraded';
  return new Reply(ready ? 200 : 503, { status, draining, checks: { database: { ok: database.ok, latencyMs: database.latencyMs }, redis: { ok: redis.ok, latencyMs: redis.latencyMs } } });
});

/** Development-only mailbox: shows the verification / invitation / reset emails the dev transport "sent". */
system.get('/dev/mailbox', { auth: 'public', query: z.object({ email: z.string().email().optional() }), summary: 'DEV ONLY: list outbound emails' }, async ({ query }) => {
  if (!config.devTools) throw forbidden('Not available in production');
  const rows = await db().outboundEmail.findMany({ where: query.email ? { toEmail: query.email.toLowerCase() } : {}, orderBy: { createdAt: 'desc' }, take: 50 });
  return rows;
});

/** Development convenience: run one scheduler pass now instead of waiting for the minute tick (used by e2e tests). */
system.post('/dev/scheduler/tick', { auth: 'public', summary: 'DEV ONLY: run the background scheduler once' }, async () => {
  if (!config.devTools) throw forbidden('Not available in production');
  const { runSchedulerTick } = await import('../automations/scheduler');
  await runSchedulerTick();
  return { ran: true };
});
