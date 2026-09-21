import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

const reg = {
  tenant: { slug: 'test-firma', name: 'Тест Фирма ДООЕЛ', countryCode: 'mk' },
  user: { email: 'ana@test.mk', password: 'correct-horse-1', firstName: 'Ана', lastName: 'Тестова' },
};

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first).split(';')[0]!;
}

describe('auth', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(async () => { await t.close(); });

  it('registers a tenant with an owner user, sets a session cookie and seeds tax rates', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: reg });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.tenant).toMatchObject({ slug: 'test-firma', countryCode: 'mk', currency: 'MKD', locale: 'mk-MK' });
    expect(body.user).toMatchObject({ email: 'ana@test.mk', role: 'owner' });
    expect(body.user.passwordHash).toBeUndefined();
    expect(cookieOf(res)).toMatch(/^domar_session=/);
    const rates = await t.db.query.taxRates.findMany();
    expect(rates.map((r) => r.rateBp).sort((a, b) => a - b)).toEqual([0, 500, 1000, 1800]);
    expect(rates.find((r) => r.isDefault)?.rateBp).toBe(1800);
  });

  it('rejects a duplicate slug', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: reg });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('slug_taken');
  });

  it('rejects short passwords', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { ...reg, tenant: { ...reg.tenant, slug: 'other' }, user: { ...reg.user, password: 'short' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  it('logs in with tenant slug, email and password', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: 'test-firma', email: 'ANA@test.mk', password: 'correct-horse-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('ana@test.mk');
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieOf(res) } });
    expect(me.statusCode).toBe(200);
    expect(me.json().tenant.slug).toBe('test-firma');
  });

  it('rejects a wrong password with a generic error', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: 'test-firma', email: 'ana@test.mk', password: 'nope-nope-nope' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_credentials');
  });

  it('rejects a wrong tenant slug with the same generic error', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: 'ghost', email: 'ana@test.mk', password: 'correct-horse-1' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_credentials');
  });

  it('me without a cookie is 401', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('logout clears the session', async () => {
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: 'test-firma', email: 'ana@test.mk', password: 'correct-horse-1' } });
    const cookie = cookieOf(login);
    const out = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });
});
