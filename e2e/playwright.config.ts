import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  // Three specs render PDFs through a real Chrome in the API process; at full worker count they
  // queue behind each other and a 5 s assertion window is not enough.
  workers: 4,
  expect: { timeout: 15_000 },
  use: { baseURL: 'http://localhost:5180', channel: 'chrome', headless: true, testIdAttribute: 'data-test' },
  // `reuseExistingServer` means an API already up from `pnpm dev` keeps its own `AUTH_RATE_MAX`, not
  // the 200 below, and the login-heavy specs run back into the ceiling this override exists to lift.
  // Run `pnpm e2e` with no separate `pnpm dev` API listening on 3001.
  webServer: [
    { command: 'pnpm --filter @domar/api dev', url: 'http://localhost:3001/api/health', reuseExistingServer: true, cwd: '..', timeout: 120_000, env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://domar:domar@localhost:54329/domar', NODE_ENV: 'development', CORS_ORIGINS: 'http://localhost:5180', SMTP_URL: 'json', AUTH_RATE_MAX: '200', ACCOUNTING_RATE_MAX: '200', JOB_TOKEN: 'e2e-job-token-not-a-secret' } },
    // Port 5180, not 5173: 5173 is often already taken by other local dev servers.
    // `exec vite --port` (not `pnpm --filter @domar/web dev -- --port`): pnpm forwards `--` literally
    // to the `dev` script, so `exec` is needed to pass `--port`/`--strictPort` straight to the vite binary.
    { command: 'pnpm --filter @domar/web exec vite --port 5180 --strictPort', url: 'http://localhost:5180', reuseExistingServer: true, cwd: '..', timeout: 120_000 },
  ],
});
