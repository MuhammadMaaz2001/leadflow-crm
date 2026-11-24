import { config } from '../config';
import { log } from './logger';
import { reportError } from './error-report';

/**
 * Graceful shutdown: on SIGTERM/SIGINT run the registered closers in reverse registration order
 * (e.g. stop accepting HTTP → drain worker → close queue/redis → disconnect Prisma), bounded by SHUTDOWN_TIMEOUT_MS.
 * Uncaught exceptions / unhandled rejections are reported and terminate the process so the platform restarts it.
 */
type Closer = { name: string; fn: () => Promise<void> | void };
const closers: Closer[] = [];
let installed = false;
let shuttingDown = false;
export const isShuttingDown = () => shuttingDown;
export const onShutdown = (name: string, fn: Closer['fn']) => { closers.push({ name, fn }); };

export async function shutdown(reason: string, exitCode = 0, exit: (code: number) => void = process.exit) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown started', { reason });
  const timer = setTimeout(() => { log.error('shutdown timed out, forcing exit', { timeoutMs: config.shutdownTimeoutMs }); exit(1); }, config.shutdownTimeoutMs);
  timer.unref();
  for (const c of [...closers].reverse()) {
    try { await c.fn(); log.info('shutdown step done', { step: c.name }); } catch (e) { log.error('shutdown step failed', { step: c.name, error: e }); exitCode = exitCode || 1; }
  }
  clearTimeout(timer);
  log.info('shutdown complete');
  exit(exitCode);
}

export function installProcessHandlers() {
  if (installed) return; installed = true;
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => { reportError(e, 'unhandledRejection'); });
  process.on('uncaughtException', (e) => { reportError(e, 'uncaughtException'); void shutdown('uncaughtException', 1); });
}
