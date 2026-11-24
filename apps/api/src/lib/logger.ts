import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Structured JSON logging (one object per line on stdout/stderr) with automatic redaction of secrets
 * and automatic request correlation (`requestId`) via AsyncLocalStorage.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const requestStore = new AsyncLocalStorage<{ requestId: string; userId?: string; orgId?: string }>();
export const runWithRequest = <T>(requestId: string, fn: () => T): T => requestStore.run({ requestId }, fn);
export const currentRequest = () => requestStore.getStore();
export const newRequestId = () => randomUUID();
/** Accept a caller supplied request id only when it is a short, harmless token (prevents log injection). */
export const sanitizeRequestId = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9._:-]{8,64}$/.test(v) ? v : null);

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential|private|signature|dsn|^link$/i;
const MAX_DEPTH = 5;

export function redact(value: unknown, depth = 0): unknown {
  if (value == null || typeof value !== 'object') return typeof value === 'string' ? redactString(value) : value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (value instanceof Error) return errorToObject(value, depth);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}
/** Strip credentials from URLs / connection strings and one-time tokens from query strings. */
export function redactString(s: string): string {
  return s
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, '$1$2:[redacted]@')
    .replace(/([?&](?:token|key|signature|x-amz-signature|password)=)[^&\s"']+/gi, '$1[redacted]');
}
function errorToObject(e: Error, depth: number) {
  const o: Record<string, unknown> = { name: e.name, message: redactString(e.message), stack: e.stack ? redactString(e.stack).split('\n').slice(0, 12).join('\n') : undefined };
  const code = (e as { code?: unknown }).code;
  if (code !== undefined) o.code = code;
  if (e.cause && depth < 2) o.cause = redact(e.cause, depth + 1);
  return o;
}

type Sink = (line: string, level: Level) => void;
let sink: Sink = (line, level) => { (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n'); };
/** Tests capture output through this. */
export const setLogSink = (s: Sink | null) => { sink = s ?? ((line, level) => { (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n'); }); };

let minLevel: Level = (process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : (process.env.VITEST ? 'warn' : 'info');
export const setLogLevel = (l: Level) => { minLevel = l; };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const emit = (level: Level, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const req = requestStore.getStore();
    const line = { time: new Date().toISOString(), level, msg: redactString(msg), ...(req ? { requestId: req.requestId, ...(req.userId ? { userId: req.userId } : {}), ...(req.orgId ? { orgId: req.orgId } : {}) } : {}), ...(redact(bindings) as object), ...(data ? (redact(data) as object) : {}) };
    try { sink(JSON.stringify(line), level); } catch { /* never let logging crash the process */ }
  };
  return {
    debug: (m, d) => emit('debug', m, d), info: (m, d) => emit('info', m, d), warn: (m, d) => emit('warn', m, d), error: (m, d) => emit('error', m, d),
    child: (b) => createLogger({ ...bindings, ...b }),
  };
}
export const log = createLogger({ service: process.env.SERVICE_NAME ?? 'leadflow-api' });
/** Attach the authenticated principal to the current request's log lines. */
export function bindRequestPrincipal(p: { userId?: string; orgId?: string }) {
  const s = requestStore.getStore();
  if (s) Object.assign(s, p);
}
