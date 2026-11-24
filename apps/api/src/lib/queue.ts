import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';

export type JobName = 'automation.execute' | 'scheduler.tick';
type Processor = (data: Record<string, unknown>) => Promise<void>;
const processors = new Map<JobName, Processor>();
export const registerProcessor = (name: JobName, fn: Processor) => processors.set(name, fn);
export const runProcessor = async (name: JobName, data: Record<string, unknown>) => {
  const p = processors.get(name);
  if (!p) throw new Error(`No processor registered for ${name}`);
  await p(data);
};

export const QUEUE_NAME = 'leadflow';
let connection: IORedis | null = null;
let queue: Queue | null = null;

export function redisConnection() {
  if (!connection) connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
  return connection;
}
function getQueue() {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: redisConnection() });
  return queue;
}

/**
 * Enqueue a background job (BullMQ/Redis). With JOBS_INLINE=true (tests, single-process dev) the job runs
 * immediately in-process instead, using the very same processor.
 */
export async function enqueue(name: JobName, data: Record<string, unknown>, opts: { jobId?: string; delay?: number } = {}) {
  if (config.jobsInline) {
    await runProcessor(name, data);
    return;
  }
  await getQueue().add(name, data, {
    jobId: opts.jobId, delay: opts.delay, attempts: 3, backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 500, removeOnFail: 1000,
  });
}

export async function scheduleRepeatables() {
  const q = getQueue();
  await q.upsertJobScheduler('scheduler-tick', { every: 60_000 }, { name: 'scheduler.tick', data: {}, opts: { removeOnComplete: 50, removeOnFail: 100 } });
}

export async function redisHealthy(): Promise<boolean> {
  try {
    return (await redisConnection().ping()) === 'PONG';
  } catch {
    return false;
  }
}
