import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('tax rates', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    b = await registerTenant(t.app, 'firma-b');
  });
  afterAll(async () => { await t.close(); });

  it('lists the seeded rates of the caller tenant only', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as { name: string; rateBp: number }[];
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => typeof r.rateBp === 'number')).toBe(true);
  });

  it('creates a rate and writes an audit entry', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/tax-rates', headers: { cookie: a.cookie }, payload: { name: 'Посебна 7%', rateBp: 700 } });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created).toMatchObject({ name: 'Посебна 7%', rateBp: 700, isDefault: false, isActive: true });
    const audit = await t.db.query.auditLogs.findMany();
    const entry = audit.find((e) => e.entityId === created.id);
    expect(entry).toMatchObject({ action: 'tax_rate.create', entityType: 'tax_rate', userId: a.userId, tenantId: a.tenantId });
  });

  it('making a rate default clears the previous default', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie: a.cookie } });
    const five = list.json().rows.find((r: { rateBp: number }) => r.rateBp === 500);
    const res = await t.app.inject({ method: 'PATCH', url: `/api/tax-rates/${five.id}`, headers: { cookie: a.cookie }, payload: { isDefault: true } });
    expect(res.statusCode).toBe(200);
    const after = await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie: a.cookie } });
    const defaults = after.json().rows.filter((r: { isDefault: boolean }) => r.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].rateBp).toBe(500);
  });

  it('tenant B cannot read or modify tenant A rates', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie: a.cookie } });
    const idA = list.json().rows[0].id;
    const get = await t.app.inject({ method: 'GET', url: `/api/tax-rates/${idA}`, headers: { cookie: b.cookie } });
    expect(get.statusCode).toBe(404);
    const patch = await t.app.inject({ method: 'PATCH', url: `/api/tax-rates/${idA}`, headers: { cookie: b.cookie }, payload: { name: 'hacked' } });
    expect(patch.statusCode).toBe(404);
  });

  it('soft-deletes a rate', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/tax-rates', headers: { cookie: a.cookie }, payload: { name: 'Tmp', rateBp: 100 } });
    const id = created.json().id;
    const del = await t.app.inject({ method: 'DELETE', url: `/api/tax-rates/${id}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(204);
    const list = await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie: a.cookie } });
    expect(list.json().rows.find((r: { id: string }) => r.id === id)).toBeUndefined();
    const all = await t.app.inject({ method: 'GET', url: '/api/tax-rates?includeInactive=true', headers: { cookie: a.cookie } });
    expect(all.json().rows.find((r: { id: string }) => r.id === id)?.isActive).toBe(false);
  });

  it('requires auth', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/tax-rates' });
    expect(res.statusCode).toBe(401);
  });

  it('validates rateBp range', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/tax-rates', headers: { cookie: a.cookie }, payload: { name: 'x', rateBp: 20000 } });
    expect(res.statusCode).toBe(400);
  });
});
