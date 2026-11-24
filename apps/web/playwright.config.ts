import { defineConfig, devices } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: WEB, actionTimeout: 15_000, navigationTimeout: 30_000, trace: 'off', screenshot: 'only-on-failure', video: 'off', launchOptions: { args: ['--no-sandbox'] } },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testMatch: /.*\.spec\.ts/, testIgnore: /responsive/ },
    { name: 'responsive', use: { ...devices['Desktop Chrome'] }, testMatch: /responsive\.spec\.ts/ },
  ],
  // Starts the API (development mode: dev mailbox + verification links) and the production web build.
  // Requires PostgreSQL + Redis running, migrated and seeded (see ENVIRONMENT_SETUP.md).
  webServer: [
    { command: 'npm run dev:e2e -w @leadflow/api', url: `${API}/api/health`, reuseExistingServer: true, timeout: 90_000, cwd: '../..' },
    { command: 'npm run start -w @leadflow/web', url: `${WEB}/login`, reuseExistingServer: true, timeout: 90_000, cwd: '../..' },
  ],
});
