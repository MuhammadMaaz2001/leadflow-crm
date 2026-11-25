import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { log } from './logger';
import { jobDuration, jobRetries, jobsProcessed } from './metrics';

export type JobName = 'automation.execute' | 'scheduler.tick' | 'email.send' | 'import.process';
type Processor = (data: Record<string, unknown>) => Promise<void>;
const processors = new Map<JobName, Processor>();
export const registerProcessor = (name: JobName, fn: Processor) => processors.set(name, fn);
export const runProcessor = async (name: JobName, data: Record<string, unknown>, attempt = 0) => {
  const p = processors.get(name);
  if (!p) throw new Error(`No processor registered for ${name}`);
  const end = jobDuration.startTimer({ job: name });
  if (attempt > 0) jobRetries.inc({ job: name });
  try { await p(data); jobsProcessed.inc({ job: name, result: 'success' }); }
  catch (e) { jobsProcessed.inc({ job: name, result: 'failure' }); throw e; }
  finally { end(); }
};

export const QUEUE_NAME = process.env.QUEUE_NAME ?? 'leadflow';

/** Retry policy for every job: 5 attempts, exponential backoff 5s → 10s → 20s → 40s. Failed jobs stay inspectable for 14 days (dead-letter set). */
export const JOB_ATTEMPTS = 5;
export const JOB_DEFAULTS: JobsOptions = {
  attempts: JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: Number(process.env.JOB_BACKOFF_MS ?? 5000) },
  removeOnComplete: { count: 500, age: 24 * 3600 },
  removeOnFail: { count: 5000, age: 14 * 24 * 3600 },
};

let connection: IORedis | null = null;
let queue: Queue | null = null;

/** BullMQ connection (blocking commands need maxRetriesPerRequest: null). */
export function redisConnection() {
  if (!connection) {
    connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
    connection.on('error', (e) => log.warn('bullmq redis connection error', { error: e.message }));
  }
  return connection;
}
export function getQueue() {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: redisConnection(), defaultJobOptions: JOB_DEFAULTS });
  return queue;
}
export async function closeQueue() {
  const q = queue; queue = null;
  if (q) await q.close().catch(() => undefined);
  const c = connection; connection = null;
  if (c) { try { await c.quit(); } catch { c.disconnect(); } }
}

/**
 * Enqueue a background job (BullMQ/Redis). With JOBS_INLINE=true (tests, single-process dev) the job runs
 * immediately in-process instead, using the very same processor. A job id makes the enqueue idempotent:
 * BullMQ ignores an add() whose id already exists in the queue.
 */
export async function enqueue(name: JobName, data: Record<string, unknown>, opts: { jobId?: string; delay?: number } = {}) {
  if (config.jobsInline) {
    await runProcessor(name, data);
    return;
  }
  await getQueue().add(name, data, { jobId: opts.jobId, delay: opts.delay });
}

export async function scheduleRepeatables() {
  // One repeatable scheduler definition for the whole cluster (upsert is idempotent, so every worker may call it).
  await getQueue().upsertJobScheduler('scheduler-tick', { every: 60_000 }, { name: 'scheduler.tick', data: {}, opts: { attempts: 1, removeOnComplete: 50, removeOnFail: 100 } });
}

export async function queueCounts() {
  return getQueue().getJobCounts('waiting', 'active', 'failed', 'delayed', 'completed');
}
