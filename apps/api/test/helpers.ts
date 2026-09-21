import { createTestDatabase } from '@domar/db/test-db';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

export async function createTestApp(): Promise<{ app: FastifyInstance; db: Awaited<ReturnType<typeof createTestDatabase>>['db']; close(): Promise<void> }> {
  const t = await createTestDatabase();
  const config = loadConfig({ ...process.env, DATABASE_URL: t.url, NODE_ENV: 'test' });
  const app = await buildApp({ db: t.db, sql: t.sql, config });
  await app.ready();
  return {
    app,
    db: t.db,
    async close() {
      await app.close();
      await t.close();
    },
  };
}
