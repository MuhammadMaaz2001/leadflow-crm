import http from 'node:http';
import { createApp } from './app';
import { config } from './config';
import { validateProductionConfig } from './config-validate';
import { ensurePlans } from './modules/subscriptions/service';
import { registerProcessors } from './jobs';
import { log } from './lib/logger';
import { closeRedis } from './lib/redis';
import { closeQueue } from './lib/queue';
import { installProcessHandlers, onShutdown } from './lib/shutdown';
import { platformPrisma, prisma } from './db';
import { probeRole, roleProblems } from './lib/health';

async function main() {
  if (config.isProd) {
    const r = validateProductionConfig(process.env);
    for (const w of r.warnings) log.warn(`config: ${w}`);
    if (r.errors.length) { for (const e of r.errors) log.error(`config: ${e}`); throw new Error(`Refusing to start: ${r.errors.length} production configuration error(s). Run "npm run check:config -w @leadflow/api".`); }
  }
  installProcessHandlers();
  // Fail fast if the database user would silently disable row level security (e.g. the owner/superuser URL was pasted into APP_DATABASE_URL).
  const problems = roleProblems(await probeRole(prisma), await probeRole(platformPrisma));
  if (problems.length) { for (const m of problems) log.error(`database role check: ${m}`); if (config.isProd) throw new Error('Refusing to start with unsafe database roles.'); }
  await ensurePlans();
  registerProcessors();
  const app = createApp();
  const server = http.createServer(app);
  // Keep-alive above typical load-balancer idle timeouts (AWS ALB 60 s) to avoid sporadic 502s.
  server.keepAliveTimeout = 65_000; server.headersTimeout = 66_000; server.requestTimeout = 120_000;
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  log.info('API listening', { port: config.port, env: config.env, docs: config.apiDocs ? '/api/docs' : 'disabled', rateLimitStore: config.rateLimitStore });
  onShutdown('http-server', () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); setTimeout(() => server.closeAllConnections(), Math.max(1000, config.shutdownTimeoutMs - 5000)).unref(); }));
  onShutdown('connections', async () => { await closeQueue(); await closeRedis(); await prisma.$disconnect(); await platformPrisma.$disconnect(); });
}
main().catch((e) => { log.error('API failed to start', { error: e }); process.exit(1); });
