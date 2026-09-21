import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('contacts', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    b = await registerTenant(t.app, 'firma-b');
  });
  afterAll(async () => { await t.close(); });

  it('creates a person contact with defaults', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie: a.cookie }, payload: { firstName: 'Петар', lastName: 'Петров', email: 'petar@example.mk' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'person', firstName: 'Петар', lastName: 'Петров', email: 'petar@example.mk', phone: null });
  });

  it('creates a company contact requiring a company number', async () => {
    const bad = await t.app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie: a.cookie }, payload: { kind: 'company', lastName: 'Фирма ДОО' } });
    expect(bad.statusCode).toBe(400);
    const ok = await t.app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie: a.cookie }, payload: { kind: 'company', lastName: 'Фирма ДОО', companyNumber: '1234567' } });
    expect(ok.statusCode).toBe(201);
  });

  it('lists with search and pagination', async () => {
    for (const n of ['Ана', 'Бојан', 'Влатко']) {
      await t.app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie: a.cookie }, payload: { firstName: n, lastName: 'Тест' } });
    }
    const all = await t.app.inject({ method: 'GET', url: '/api/contacts?pageSize=2', headers: { cookie: a.cookie } });
    expect(all.json().rows).toHaveLength(2);
    expect(all.json().total).toBe(5);
    const found = await t.app.inject({ method: 'GET', url: '/api/contacts?search=боја', headers: { cookie: a.cookie } });
    expect(found.json().rows.map((r: { firstName: string }) => r.firstName)).toEqual(['Бојан']);
  });

  it('updates and deletes', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie: a.cookie }, payload: { firstName: 'X', lastName: 'Y' } });
    const id = created.json().id;
    const upd = await t.app.inject({ method: 'PATCH', url: `/api/contacts/${id}`, headers: { cookie: a.cookie }, payload: { phone: '+389 70 000 000' } });
    expect(upd.json().phone).toBe('+389 70 000 000');
    const del = await t.app.inject({ method: 'DELETE', url: `/api/contacts/${id}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(204);
    const get = await t.app.inject({ method: 'GET', url: `/api/contacts/${id}`, headers: { cookie: a.cookie } });
    expect(get.statusCode).toBe(404);
  });

  it('cannot be patched to kind company without a company number', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie: a.cookie }, payload: { firstName: 'No', lastName: 'Company' } });
    const id = created.json().id;
    const res = await t.app.inject({ method: 'PATCH', url: `/api/contacts/${id}`, headers: { cookie: a.cookie }, payload: { kind: 'company' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  it('is tenant isolated', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/api/contacts', headers: { cookie: b.cookie } });
    expect(list.json().total).toBe(0);
  });
});
