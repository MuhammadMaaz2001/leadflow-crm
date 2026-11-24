import { execSync } from 'node:child_process';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export default async function setup() {
  const base = process.env.DATABASE_URL ?? '';
  const admin = base.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
  const testUrl = base.replace(/\/[^/?]+(\?|$)/, '/leadflow_test$1');
  const run = (cmd: string, env: Record<string, string> = {}) =>
    execSync(cmd, { stdio: 'pipe', env: { ...process.env, ...env }, cwd: path.resolve(__dirname, '../../../packages/database') });
  try {
    run(`psql "${admin}" -c "DROP DATABASE IF EXISTS leadflow_test WITH (FORCE)"`);
    run(`psql "${admin}" -c "CREATE DATABASE leadflow_test"`);
  } catch (e) {
    throw new Error(`Could not (re)create test database: ${(e as Error).message}`);
  }
  run('npx prisma migrate deploy', { DATABASE_URL: testUrl });
  run('npx tsx scripts/set-role-passwords.ts', {
    DATABASE_URL: testUrl,
    APP_DB_PASSWORD: process.env.APP_DB_PASSWORD ?? 'leadflow_app_dev',
    PLATFORM_DB_PASSWORD: process.env.PLATFORM_DB_PASSWORD ?? 'leadflow_platform_dev',
  });
}
