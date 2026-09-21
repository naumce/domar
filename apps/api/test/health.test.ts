import { createDb } from '@domar/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createTestApp } from './helpers.js';

describe('health', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(async () => { await t.close(); });

  it('GET /api/health returns ok and db status', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('unknown routes return the error envelope', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Route GET /api/nope not found' } });
  });

  it('returns 503 with a degraded status when the database is unreachable', async () => {
    const downUrl = 'postgres://domar:domar@localhost:1/domar';
    const { db, sql } = createDb(downUrl, { connectTimeoutSeconds: 1 });
    const config = loadConfig({ ...process.env, DATABASE_URL: downUrl, NODE_ENV: 'test' });
    const downApp = await buildApp({ db, sql, config });
    await downApp.ready();
    try {
      const res = await downApp.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'degraded', db: 'down' });
    } finally {
      await downApp.close();
      await sql.end({ timeout: 1 });
    }
  });
});
