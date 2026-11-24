import { log } from './logger';

/**
 * Error reporting hook. Every unexpected (5xx / crashed job) error goes through `reportError`.
 * By default it only logs; deployments can attach an error tracker with `setErrorReporter`
 * (for example a thin Sentry/Rollbar wrapper) or set ERROR_WEBHOOK_URL to POST a redacted JSON event.
 */
export interface ErrorEvent { error: unknown; where: string; requestId?: string; extra?: Record<string, unknown> }
type Reporter = (e: ErrorEvent) => void | Promise<void>;
const reporters: Reporter[] = [];
export const setErrorReporter = (r: Reporter) => { reporters.push(r); };
export const clearErrorReporters = () => { reporters.length = 0; };

export function reportError(error: unknown, where: string, extra?: Record<string, unknown>) {
  log.error(`unhandled error in ${where}`, { error, ...extra });
  const url = process.env.ERROR_WEBHOOK_URL;
  const event: ErrorEvent = { error, where, extra };
  for (const r of reporters) Promise.resolve().then(() => r(event)).catch((e) => log.warn('error reporter failed', { error: e }));
  if (url && /^https:\/\//.test(url)) {
    const e = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack?.split('\n').slice(0, 10).join('\n') } : { message: String(error) };
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: process.env.SERVICE_NAME ?? 'leadflow-api', where, error: e, extra: extra ?? null, time: new Date().toISOString() }), signal: AbortSignal.timeout(3000) }).catch(() => undefined);
  }
}
