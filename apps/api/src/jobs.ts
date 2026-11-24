import { Worker } from 'bullmq';
import { registerProcessor, QUEUE_NAME, redisConnection, scheduleRepeatables } from './lib/queue';
import { executeAutomation } from './modules/automations/engine';
import { runSchedulerTick } from './modules/automations/scheduler';

export function registerProcessors() {
  registerProcessor('automation.execute', async (d) => executeAutomation(String(d.orgId), String(d.executionId)));
  registerProcessor('scheduler.tick', async () => runSchedulerTick());
}

export async function startWorker() {
  registerProcessors();
  await scheduleRepeatables();
  const worker = new Worker(QUEUE_NAME, async (job) => {
    const { runProcessor } = await import('./lib/queue');
    await runProcessor(job.name as 'automation.execute' | 'scheduler.tick', job.data);
  }, { connection: redisConnection(), concurrency: 5 });
  worker.on('failed', (job, err) => console.error(`[worker] job ${job?.name}#${job?.id} failed: ${err.message}`));
  worker.on('completed', (job) => { if (job.name !== 'scheduler.tick') console.log(`[worker] ${job.name}#${job.id} done`); });
  console.log('LeadFlow worker started: processing automations & minute scheduler');
  return worker;
}
