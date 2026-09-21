import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

describe('openapi', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(async () => { await t.close(); });

  it('GET /api/docs/json exposes the tax-rates and units routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/docs/json' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const paths = Object.keys(body.paths);
    expect(paths).toContain('/api/tax-rates');
    expect(paths).toContain('/api/buildings/{buildingId}/units');
  });
});
