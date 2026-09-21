import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('building services', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let buildingId: string; let cleaningId: string; let bulbId: string;
  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    buildingId = (await t.app.inject({ method: 'POST', url: '/api/buildings', headers: { cookie: a.cookie }, payload: { name: 'Зграда 1' } })).json().id;
    cleaningId = (await t.app.inject({ method: 'POST', url: '/api/services', headers: { cookie: a.cookie }, payload: { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000 } })).json().id;
    bulbId = (await t.app.inject({ method: 'POST', url: '/api/services', headers: { cookie: a.cookie }, payload: { name: 'Сијалица', pricing: 'fixed_per_unit', defaultPriceMinor: 2000, recurring: false } })).json().id;
  });
  afterAll(async () => { await t.close(); });
  const url = () => `/api/buildings/${buildingId}/services`;
  const post = (payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url: url(), headers: { cookie: a.cookie }, payload });

  it('attaches a recurring service with defaults from the catalog', async () => {
    const res = await post({ serviceId: cleaningId, startsPeriod: '2026-01' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ serviceId: cleaningId, frequency: 'monthly', intervalMonths: 1, priceMinor: null, effectivePriceMinor: 30000, effectivePricing: 'fixed_per_unit', service: { name: 'Чистење', taxRateBp: 0 } });
  });

  it('rejects one-time services, duplicates and bad intervals', async () => {
    expect((await post({ serviceId: bulbId, startsPeriod: '2026-01' })).json().error.code).toBe('invalid_reference');
    expect((await post({ serviceId: cleaningId, startsPeriod: '2026-01' })).statusCode).toBe(409);
    const bad = await post({ serviceId: bulbId, startsPeriod: '2026-01', frequency: 'every_n_months', intervalMonths: 1 });
    expect(bad.statusCode).toBe(400);
    expect((await post({ serviceId: cleaningId, startsPeriod: '2026-05', endsPeriod: '2026-04' })).statusCode).toBe(400);
  });

  it('overrides price and pricing per building and reports effective values', async () => {
    const list = await t.app.inject({ method: 'GET', url: url(), headers: { cookie: a.cookie } });
    const id = list.json().rows[0].id;
    const upd = await t.app.inject({ method: 'PATCH', url: `${url()}/${id}`, headers: { cookie: a.cookie }, payload: { priceMinor: 500000, pricing: 'shared_total', frequency: 'every_n_months', intervalMonths: 3 } });
    expect(upd.statusCode).toBe(200);
    expect(upd.json()).toMatchObject({ priceMinor: 500000, pricing: 'shared_total', effectivePriceMinor: 500000, effectivePricing: 'shared_total', intervalMonths: 3 });
    const back = await t.app.inject({ method: 'PATCH', url: `${url()}/${id}`, headers: { cookie: a.cookie }, payload: { priceMinor: null, pricing: null, frequency: 'monthly' } });
    expect(back.json()).toMatchObject({ priceMinor: null, effectivePriceMinor: 30000, effectivePricing: 'fixed_per_unit', frequency: 'monthly', intervalMonths: 1 });
  });

  it('is tenant isolated and detaches', async () => {
    const b = await registerTenant(t.app, 'firma-b');
    expect((await t.app.inject({ method: 'GET', url: url(), headers: { cookie: b.cookie } })).statusCode).toBe(404);
    const list = await t.app.inject({ method: 'GET', url: url(), headers: { cookie: a.cookie } });
    const del = await t.app.inject({ method: 'DELETE', url: `${url()}/${list.json().rows[0].id}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: url(), headers: { cookie: a.cookie } })).json().rows).toHaveLength(0);
  });
});
