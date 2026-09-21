import { schema } from '@domar/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first).split(';')[0]!;
}

describe('role gating', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let readonlyCookie: string;

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    const passwordHash = await hashPassword('correct-horse-1');
    await t.db.insert(schema.users).values({
      tenantId: a.tenantId, email: 'ro@firma-a.mk', passwordHash, firstName: 'R', lastName: 'O', role: 'readonly',
    });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: 'firma-a', email: 'ro@firma-a.mk', password: 'correct-horse-1' } });
    expect(login.statusCode).toBe(200);
    readonlyCookie = cookieOf(login);
  });
  afterAll(async () => { await t.close(); });

  it('a readonly user can read tax rates', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie: readonlyCookie } });
    expect(res.statusCode).toBe(200);
  });

  it('a readonly user cannot create tax rates', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/tax-rates', headers: { cookie: readonlyCookie }, payload: { name: 'x', rateBp: 100 } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });
});
