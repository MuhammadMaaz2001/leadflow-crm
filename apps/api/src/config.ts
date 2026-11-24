import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true }); // quiet: keep stdout pure JSON logs

const env = process.env;
const isTest = env.NODE_ENV === 'test' || !!env.VITEST;
// Fail-safe: anything that is not explicitly "development" or "test" is treated as production
// (secure cookies, no dev mailbox, no dev links). `npm run dev` sets NODE_ENV=development explicitly.
const isDev = env.NODE_ENV === 'development' && env.ALLOW_DEV_TOOLS !== 'false';

/** Adds a connection limit / pool timeout to a Postgres URL unless the URL already sets them. */
export function withPool(url: string | undefined, limit: number, timeoutS: number): string | undefined {
  if (!url) return url;
  const u = new URL(url);
  if (!u.searchParams.has('connection_limit')) u.searchParams.set('connection_limit', String(limit));
  if (!u.searchParams.has('pool_timeout')) u.searchParams.set('pool_timeout', String(timeoutS));
  return u.toString();
}
const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : d; };
const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[], d: T): T => ((allowed as readonly string[]).includes(v ?? '') ? (v as T) : d);

export const config = {
  env: env.NODE_ENV ?? 'unset (treated as production)',
  isProd: !isDev && !isTest,
  devTools: isDev || isTest,
  isTest,
  port: Number(env.API_PORT ?? 4000),
  apiUrl: env.API_URL ?? 'http://localhost:4000',
  webUrl: (env.WEB_URL ?? 'http://localhost:3000').split(',')[0]!.trim(),
  allowedOrigins: (env.WEB_URL ?? 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
  appDatabaseUrl: withPool(env.APP_DATABASE_URL ?? env.DATABASE_URL, num(env.DB_POOL_MAX, 20), num(env.DB_POOL_TIMEOUT_S, 20))!,
  platformDatabaseUrl: withPool(env.PLATFORM_DATABASE_URL ?? env.DATABASE_URL, num(env.DB_PLATFORM_POOL_MAX, 5), num(env.DB_POOL_TIMEOUT_S, 20))!,
  ownerDatabaseUrl: env.DATABASE_URL!,
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  jobsInline: env.JOBS_INLINE === 'true' || isTest,
  // __Host- prefix in production: the browser then refuses the cookie unless it is Secure, Path=/ and has no Domain attribute.
  cookieName: env.SESSION_COOKIE_NAME ?? (!isDev && !isTest ? '__Host-lf_session' : 'lf_session'),
  sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 14),
  sessionIdleDays: Number(env.SESSION_IDLE_DAYS ?? 7),
  rateLimit: !isTest && env.DISABLE_RATE_LIMIT !== 'true',
  rateLimitStore: oneOf(env.RATE_LIMIT_STORE, ['redis', 'memory'] as const, 'redis'),
  /** Number of reverse-proxy hops in front of the API (used to resolve the real client IP). */
  trustProxy: num(env.TRUST_PROXY, 1),
  logLevel: env.LOG_LEVEL,
  /** Workspaces with at least this many leads get 20 s result caching for list totals, dashboard and reports (0 = never). */
  largeWorkspaceLeads: num(env.LARGE_WORKSPACE_LEADS, 20000),
  cacheTtlSeconds: num(env.CACHE_TTL_SECONDS, 20),
  /** Log statements slower than this many ms (0 = off). Recommended in production: 500. */
  slowQueryMs: num(env.SLOW_QUERY_MS, 0),
  /** Swagger UI + /api/openapi.json. Off by default in production. */
  apiDocs: env.API_DOCS ? env.API_DOCS === 'true' : !(!isDev && !isTest),
  accessLog: env.ACCESS_LOG !== 'false' && !isTest,
  // background processing
  workerConcurrency: num(env.WORKER_CONCURRENCY, 5),
  shutdownTimeoutMs: num(env.SHUTDOWN_TIMEOUT_MS, 25_000),
  workerHealthPort: env.WORKER_HEALTH_PORT ? num(env.WORKER_HEALTH_PORT, 0) : null,
  schedulerLockMs: num(env.SCHEDULER_LOCK_MS, 120_000),
  // providers (all selected explicitly; nothing is ever "pretend delivered")
  emailTransport: oneOf(env.EMAIL_TRANSPORT, ['dev', 'smtp', 'none'] as const, 'dev'),
  emailFrom: env.EMAIL_FROM ?? 'LeadFlow <no-reply@localhost>',
  smtp: { host: env.SMTP_HOST, port: num(env.SMTP_PORT, 587), user: env.SMTP_USER, pass: env.SMTP_PASSWORD, secure: env.SMTP_SECURE === 'true' },
  storageProvider: oneOf(env.STORAGE_PROVIDER, ['db', 's3'] as const, 'db'),
  s3: { endpoint: env.S3_ENDPOINT, region: env.S3_REGION ?? 'us-east-1', bucket: env.S3_BUCKET, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true' },
  paymentProvider: oneOf(env.PAYMENT_PROVIDER, ['manual'] as const, 'manual'),
};
