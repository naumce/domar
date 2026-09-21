import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:5180', channel: 'chrome', headless: true, testIdAttribute: 'data-test' },
  webServer: [
    { command: 'pnpm --filter @domar/api dev', url: 'http://localhost:3001/api/health', reuseExistingServer: true, cwd: '..', timeout: 120_000, env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://domar:domar@localhost:54329/domar', NODE_ENV: 'development', CORS_ORIGINS: 'http://localhost:5180' } },
    { command: 'pnpm --filter @domar/web exec vite --port 5180 --strictPort', url: 'http://localhost:5180', reuseExistingServer: true, cwd: '..', timeout: 120_000 },
  ],
});
