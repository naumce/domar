import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('buildings', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    b = await registerTenant(t.app, 'firma-b');
  });
  afterAll(async () => { await t.close(); });

  it('creates a building with tenant country as default', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/buildings', headers: { cookie: a.cookie }, payload: { name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Партизанска 12', countryCode: 'mk', shareBasis: 'area', representativeContactId: null });
  });

  it('rejects a representative from another tenant', async () => {
    const c = await t.app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie: b.cookie }, payload: { firstName: 'B', lastName: 'Rep' } });
    const res = await t.app.inject({ method: 'POST', url: '/api/buildings', headers: { cookie: a.cookie }, payload: { name: 'X', representativeContactId: c.json().id } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_reference');
  });

  it('accepts a representative from the same tenant and lists with unitCount', async () => {
    const c = await t.app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie: a.cookie }, payload: { firstName: 'A', lastName: 'Rep' } });
    const res = await t.app.inject({ method: 'POST', url: '/api/buildings', headers: { cookie: a.cookie }, payload: { name: 'Y', representativeContactId: c.json().id, shareBasis: 'equal' } });
    expect(res.statusCode).toBe(201);
    const list = await t.app.inject({ method: 'GET', url: '/api/buildings', headers: { cookie: a.cookie } });
    expect(list.json().rows).toHaveLength(2);
    expect(list.json().rows[0].unitCount).toBe(0);
  });

  it('updates, isolates and deletes', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/api/buildings', headers: { cookie: a.cookie } });
    const id = list.json().rows[0].id;
    const upd = await t.app.inject({ method: 'PATCH', url: `/api/buildings/${id}`, headers: { cookie: a.cookie }, payload: { reserveFundAccount: '200003456789012' } });
    expect(upd.json().reserveFundAccount).toBe('200003456789012');
    const other = await t.app.inject({ method: 'GET', url: `/api/buildings/${id}`, headers: { cookie: b.cookie } });
    expect(other.statusCode).toBe(404);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/buildings/${id}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(204);
  });
});
