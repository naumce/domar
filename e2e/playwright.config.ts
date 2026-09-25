import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  // Three specs render PDFs through a real Chrome in the API process; at full worker count they
  // queue behind each other and a 5 s assertion window is not enough.
  workers: 4,
  expect: { timeout: 15_000 },
  use: { baseURL: 'http://localhost:5180', channel: 'chrome', headless: true, testIdAttribute: 'data-test' },
  webServer: [
    { command: 'pnpm --filter @domar/api dev', url: 'http://localhost:3001/api/health', reuseExistingServer: true, cwd: '..', timeout: 120_000, env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://domar:domar@localhost:54329/domar', NODE_ENV: 'development', CORS_ORIGINS: 'http://localhost:5180', SMTP_URL: 'json' } },
    // Port 5180, not 5173: 5173 is often already taken by other local dev servers.
    // `exec vite --port` (not `pnpm --filter @domar/web dev -- --port`): pnpm forwards `--` literally
    // to the `dev` script, so `exec` is needed to pass `--port`/`--strictPort` straight to the vite binary.
    { command: 'pnpm --filter @domar/web exec vite --port 5180 --strictPort', url: 'http://localhost:5180', reuseExistingServer: true, cwd: '..', timeout: 120_000 },
  ],
});
