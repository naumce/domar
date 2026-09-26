import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '@domar/db/test-db';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

export async function createTestApp(env: Record<string, string> = {}): Promise<{ app: FastifyInstance; db: Awaited<ReturnType<typeof createTestDatabase>>['db']; dataDir: string; close(): Promise<void> }> {
  const t = await createTestDatabase();
  // Uploads must not land in the repo, and one suite's files must not outlive it.
  const dataDir = await mkdtemp(join(tmpdir(), 'domar-data-'));
  // `AUTH_RATE_MAX` before the `process.env` spread would be beaten by it: `rate-limit.test.ts`
  // counts eleven logins to a 429, so the harness pins the ceiling rather than inheriting whatever
  // the person running the suite happens to export. A caller's own `env` still wins.
  const config = loadConfig({ ...process.env, DATABASE_URL: t.url, NODE_ENV: 'test', DATA_DIR: dataDir, AUTH_RATE_MAX: '10', ACCOUNTING_RATE_MAX: '200', ...env });
  const app = await buildApp({ db: t.db, sql: t.sql, config });
  await app.ready();
  return {
    app,
    db: t.db,
    dataDir,
    async close() {
      await app.close();
      await t.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
