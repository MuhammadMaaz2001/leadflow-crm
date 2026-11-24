import { z } from 'zod';
import { db } from '../../db';
import { config } from '../../config';
import { forbidden } from '../../lib/errors';
import { defineRoutes } from '../../http';

export const system = defineRoutes('System', '');

system.get('/health', { auth: 'public', summary: 'Liveness probe' }, async () => ({ status: 'ok', time: new Date().toISOString() }));

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
