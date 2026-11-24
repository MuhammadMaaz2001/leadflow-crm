import { z } from 'zod';
import { db } from '../../db';
import { config } from '../../config';
import { forbidden } from '../../lib/errors';
import { defineRoutes } from '../../http';

export const system = defineRoutes('System', '');

system.get('/health', { auth: 'public', summary: 'Liveness probe' }, async () => ({ status: 'ok', time: new Date().toISOString() }));

/** Development-only mailbox: shows the verification / invitation / reset emails the dev transport "sent". */
system.get('/dev/mailbox', { auth: 'public', query: z.object({ email: z.string().email().optional() }), summary: 'DEV ONLY: list outbound emails' }, async ({ query }) => {
  if (config.isProd) throw forbidden('Not available in production');
  const rows = await db().outboundEmail.findMany({ where: query.email ? { toEmail: query.email.toLowerCase() } : {}, orderBy: { createdAt: 'desc' }, take: 50 });
  return rows;
});
