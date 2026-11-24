import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const env = process.env;
const isTest = env.NODE_ENV === 'test' || !!env.VITEST;

export const config = {
  env: env.NODE_ENV ?? 'development',
  isProd: env.NODE_ENV === 'production',
  isTest,
  port: Number(env.API_PORT ?? 4000),
  apiUrl: env.API_URL ?? 'http://localhost:4000',
  webUrl: env.WEB_URL ?? 'http://localhost:3000',
  appDatabaseUrl: env.APP_DATABASE_URL ?? env.DATABASE_URL!,
  platformDatabaseUrl: env.PLATFORM_DATABASE_URL ?? env.DATABASE_URL!,
  ownerDatabaseUrl: env.DATABASE_URL!,
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  jobsInline: env.JOBS_INLINE === 'true' || isTest,
  cookieName: env.SESSION_COOKIE_NAME ?? 'lf_session',
  sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 14),
  rateLimit: !isTest && env.DISABLE_RATE_LIMIT !== 'true',
};
