import path from 'node:path';
import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const base = process.env.DATABASE_URL ?? 'postgresql://leadflow:leadflow_dev@localhost:5432/leadflow';
const swap = (url: string, db: string) => url.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
const TEST_DB = 'leadflow_test';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: swap(base, TEST_DB),
      APP_DATABASE_URL: swap(process.env.APP_DATABASE_URL ?? 'postgresql://leadflow_app:leadflow_app_dev@localhost:5432/leadflow', TEST_DB),
      PLATFORM_DATABASE_URL: swap(process.env.PLATFORM_DATABASE_URL ?? 'postgresql://leadflow_platform:leadflow_platform_dev@localhost:5432/leadflow', TEST_DB),
      JOBS_INLINE: 'true',
    },
  },
});
