import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('services', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let vatId: string;
  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    const rates = await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie: a.cookie } });
    vatId = rates.json().rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  });
  afterAll(async () => { await t.close(); });

  const post = (payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url: '/api/services', headers: { cookie: a.cookie }, payload });

  it('creates a recurring fixed-price service with VAT and resolves taxRateBp', async () => {
    const res = await post({ name: 'Чистење', category: 'Хигиена', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateId: vatId, appliesTo: ['apartment', 'commercial', 'apartment'] });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateBp: 1800, appliesTo: ['apartment', 'commercial'], recurring: true, isActive: true });
  });

  it('creates a one-time service without tax (taxRateBp 0) and empty appliesTo', async () => {
    const res = await post({ name: 'Замена сијалица', pricing: 'fixed_per_unit', defaultPriceMinor: 2000, recurring: false });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ recurring: false, taxRateId: null, taxRateBp: 0, appliesTo: [] });
  });

  it('rejects a foreign or inactive tax rate', async () => {
    const b = await registerTenant(t.app, 'firma-b');
    const foreign = (await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie: b.cookie } })).json().rows[0].id;
    const res = await post({ name: 'x', pricing: 'per_m2', defaultPriceMinor: 100, taxRateId: foreign });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_reference');
  });

  it('validates pricing enum and price bounds', async () => {
    expect((await post({ name: 'x', pricing: 'hourly', defaultPriceMinor: 1 })).statusCode).toBe(400);
    expect((await post({ name: 'x', pricing: 'per_m2', defaultPriceMinor: -1 })).statusCode).toBe(400);
    expect((await post({ name: 'x', pricing: 'per_m2', defaultPriceMinor: 10.5 })).statusCode).toBe(400);
  });

  it('lists with recurring filter and hides inactive by default', async () => {
    const all = await t.app.inject({ method: 'GET', url: '/api/services', headers: { cookie: a.cookie } });
    expect(all.json().rows).toHaveLength(2);
    const rec = await t.app.inject({ method: 'GET', url: '/api/services?recurring=true', headers: { cookie: a.cookie } });
    expect(rec.json().rows.map((r: { name: string }) => r.name)).toEqual(['Чистење']);
    const id = all.json().rows.find((r: { name: string }) => r.name === 'Замена сијалица').id;
    const del = await t.app.inject({ method: 'DELETE', url: `/api/services/${id}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: '/api/services', headers: { cookie: a.cookie } })).json().rows).toHaveLength(1);
    expect((await t.app.inject({ method: 'GET', url: '/api/services?includeInactive=true', headers: { cookie: a.cookie } })).json().rows).toHaveLength(2);
  });

  it('updates price and appliesTo, and is tenant isolated', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/api/services', headers: { cookie: a.cookie } });
    const id = list.json().rows[0].id;
    const upd = await t.app.inject({ method: 'PATCH', url: `/api/services/${id}`, headers: { cookie: a.cookie }, payload: { defaultPriceMinor: 35000, appliesTo: ['apartment'] } });
    expect(upd.json()).toMatchObject({ defaultPriceMinor: 35000, appliesTo: ['apartment'] });
    const b = await registerTenant(t.app, 'firma-c');
    expect((await t.app.inject({ method: 'GET', url: `/api/services/${id}`, headers: { cookie: b.cookie } })).statusCode).toBe(404);
  });
});
