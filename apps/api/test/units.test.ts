import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('units', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let buildingId: string;
  let ownerId: string;
  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    buildingId = (await t.app.inject({ method: 'POST', url: '/api/buildings', headers: { cookie: a.cookie }, payload: { name: 'Зграда 1' } })).json().id;
    ownerId = (await t.app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie: a.cookie }, payload: { firstName: 'Марко', lastName: 'Марков' } })).json().id;
  });
  afterAll(async () => { await t.close(); });

  const post = (payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url: `/api/buildings/${buildingId}/units`, headers: { cookie: a.cookie }, payload });

  it('creates an apartment with area and owner, returns numbers', async () => {
    const res = await post({ label: '12', floor: '3', kind: 'apartment', areaM2: 64.5, ownerContactId: ownerId });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ label: '12', kind: 'apartment', areaM2: 64.5, ownerContactId: ownerId, attachedToUnitId: null });
    expect(res.json().owner).toMatchObject({ firstName: 'Марко', lastName: 'Марков' });
  });

  it('rejects duplicate labels within the building', async () => {
    const res = await post({ label: '12', kind: 'apartment' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('label_taken');
  });

  it('attaches a parking spot to an apartment, rejects attaching to parking', async () => {
    const list = await t.app.inject({ method: 'GET', url: `/api/buildings/${buildingId}/units`, headers: { cookie: a.cookie } });
    const apt = list.json().rows[0].id;
    const p1 = await post({ label: 'P-1', kind: 'parking', attachedToUnitId: apt });
    expect(p1.statusCode).toBe(201);
    const p2 = await post({ label: 'P-2', kind: 'parking', attachedToUnitId: p1.json().id });
    expect(p2.statusCode).toBe(400);
    expect(p2.json().error.code).toBe('invalid_attachment');
  });

  it('rejects an owner from another tenant', async () => {
    const b = await registerTenant(t.app, 'firma-b');
    const foreign = (await t.app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie: b.cookie }, payload: { firstName: 'F', lastName: 'F' } })).json().id;
    const res = await post({ label: '99', kind: 'apartment', ownerContactId: foreign });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_reference');
    const foreignList = await t.app.inject({ method: 'GET', url: `/api/buildings/${buildingId}/units`, headers: { cookie: b.cookie } });
    expect(foreignList.statusCode).toBe(404);
  });

  it('updates and deletes', async () => {
    const list = await t.app.inject({ method: 'GET', url: `/api/buildings/${buildingId}/units`, headers: { cookie: a.cookie } });
    const parking = list.json().rows.find((u: { kind: string }) => u.kind === 'parking');
    const upd = await t.app.inject({ method: 'PATCH', url: `/api/buildings/${buildingId}/units/${parking.id}`, headers: { cookie: a.cookie }, payload: { attachedToUnitId: null, ownershipShare: 0.0125 } });
    expect(upd.statusCode).toBe(200);
    expect(upd.json()).toMatchObject({ attachedToUnitId: null, ownershipShare: 0.0125 });
    const del = await t.app.inject({ method: 'DELETE', url: `/api/buildings/${buildingId}/units/${parking.id}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(204);
  });

  it('reports unitCount on the building list matching the current unit count', async () => {
    const units = await t.app.inject({ method: 'GET', url: `/api/buildings/${buildingId}/units`, headers: { cookie: a.cookie } });
    const expectedCount = units.json().rows.length;
    const list = await t.app.inject({ method: 'GET', url: '/api/buildings', headers: { cookie: a.cookie } });
    const building = list.json().rows.find((b: { id: string }) => b.id === buildingId);
    expect(building.unitCount).toBe(expectedCount);
  });
});
