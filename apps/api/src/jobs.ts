import { Worker, type Job } from 'bullmq';
import http from 'node:http';
import { config } from './config';
import { registerProcessor, QUEUE_NAME, redisConnection, scheduleRepeatables, runProcessor, closeQueue, JOB_ATTEMPTS, type JobName } from './lib/queue';
import { executeAutomation } from './modules/automations/engine';
import { runLockedSchedulerTick } from './modules/automations/scheduler';
import { deliverEmail } from './lib/email';
import { log } from './lib/logger';
import { reportError } from './lib/error-report';
import { clearHeartbeat, publishHeartbeat, checkRedis, checkDatabase } from './lib/health';
import { closeRedis } from './lib/redis';
import { onShutdown } from './lib/shutdown';
import { prisma, platformPrisma } from './db';

export function registerProcessors() {
  registerProcessor('automation.execute', async (d) => executeAutomation(String(d.orgId), String(d.executionId)));
  registerProcessor('scheduler.tick', async () => { await runLockedSchedulerTick(); });
  registerProcessor('email.send', async (d) => deliverEmail(String(d.emailId)));
}

/**
 * Starts the BullMQ worker:
 *  - concurrency from WORKER_CONCURRENCY; stalled-job detection (a job whose worker died is re-queued; after 2 stalls it fails);
 *  - failed attempts are retried with exponential backoff (see JOB_DEFAULTS); the final failure is reported and kept in the failed set;
 *  - heartbeat in Redis every 10 s (read by /api/platform/health and the readiness checks);
 *  - graceful shutdown: stop taking jobs, wait for running ones (bounded by SHUTDOWN_TIMEOUT_MS), then close connections.
 */
export async function startWorker() {
  registerProcessors();
  await scheduleRepeatables();
  const worker = new Worker(QUEUE_NAME, async (job: Job) => {
    const t0 = Date.now();
    await runProcessor(job.name as JobName, job.data);
    if (job.name !== 'scheduler.tick') log.info('job done', { job: job.name, jobId: job.id, attempt: job.attemptsMade + 1, durationMs: Date.now() - t0 });
  }, { connection: redisConnection(), concurrency: config.workerConcurrency, stalledInterval: 30_000, maxStalledCount: 2, lockDuration: 60_000 });

  worker.on('failed', (job, err) => {
    const attempts = job?.opts.attempts ?? JOB_ATTEMPTS;
    const final = !job || job.attemptsMade >= attempts;
    log[final ? 'error' : 'warn']('job failed', { job: job?.name, jobId: job?.id, attempt: job?.attemptsMade, maxAttempts: attempts, willRetry: !final, error: err.message });
    if (final) reportError(err, `job:${job?.name}`, { jobId: job?.id });
  });
  worker.on('stalled', (jobId) => log.warn('job stalled (worker lost its lock); it will be re-queued', { jobId }));
  worker.on('error', (e) => log.error('worker error', { error: e }));

  const beat = () => publishHeartbeat({ concurrency: config.workerConcurrency }).catch((e) => log.warn('heartbeat failed', { error: (e as Error).message }));
  await beat();
  const hb = setInterval(beat, 10_000); hb.unref();

  let healthServer: http.Server | null = null;
  if (config.workerHealthPort) {
    healthServer = http.createServer(async (req, res) => {
      if (req.url !== '/health' && req.url !== '/ready') { res.writeHead(404).end(); return; }
      const [redis, database] = await Promise.all([checkRedis(), checkDatabase()]);
      const ok = redis.ok && database.ok && worker.isRunning();
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: ok ? 'ok' : 'unavailable', redis: redis.ok, database: database.ok, running: worker.isRunning() }));
    });
    healthServer.listen(config.workerHealthPort, () => log.info('worker health endpoint listening', { port: config.workerHealthPort }));
  }

  onShutdown('worker', async () => {
    clearInterval(hb);
    await new Promise<void>((r) => (healthServer ? healthServer.close(() => r()) : r()));
    await worker.close();               // waits for in-flight jobs to finish
    await clearHeartbeat();
    await closeQueue();
    await closeRedis();
    await prisma.$disconnect(); await platformPrisma.$disconnect();
  });
  log.info('worker started', { queue: QUEUE_NAME, concurrency: config.workerConcurrency });
  return worker;
}
