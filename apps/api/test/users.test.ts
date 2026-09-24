import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
}

describe('staff users', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let saraId = '';
  let saraPassword = '';
  let saraCookie = '';

  const post = (url: string, payload: Record<string, unknown>, cookie: string) => t.app.inject({ method: 'POST', url, headers: { cookie }, payload });
  const patch = (id: string, payload: Record<string, unknown>, cookie: string) => t.app.inject({ method: 'PATCH', url: `/api/users/${id}`, headers: { cookie }, payload });
  const me = (cookie: string) => t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  const users = (cookie: string) => t.app.inject({ method: 'GET', url: '/api/users', headers: { cookie } });
  const login = (password: string) => t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: 'firma-u', email: 'sara@firma-u.mk', password } });

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-u');
  });
  afterAll(async () => { await t.close(); });

  it('creates a user with a one-time 16-character temporary password that logs in', async () => {
    const res = await post('/api/users', { email: 'Sara@firma-u.mk', firstName: 'Сара', lastName: 'Стојанова', role: 'accountant' }, a.cookie);
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ email: 'sara@firma-u.mk', role: 'accountant', isActive: true });
    expect(res.json().user.passwordHash).toBeUndefined();
    saraId = res.json().user.id;
    saraPassword = res.json().temporaryPassword;
    expect(saraPassword).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);

    const ok = await login(saraPassword);          // login 1
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.isActive).toBe(true);
    saraCookie = cookieOf(ok);
    expect((await users(a.cookie)).json().rows).toHaveLength(2);
  });

  it('change-password invalidates the old password and keeps the caller signed in', async () => {
    const wrong = await post('/api/auth/change-password', { currentPassword: 'nope-nope-nope', newPassword: 'new-correct-horse-9' }, saraCookie);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid_credentials');

    const res = await post('/api/auth/change-password', { currentPassword: saraPassword, newPassword: 'new-correct-horse-9' }, saraCookie);
    expect(res.statusCode).toBe(204);
    expect((await me(saraCookie)).statusCode).toBe(200);
    expect((await login(saraPassword)).statusCode).toBe(401);   // login 2, old password
    saraPassword = 'new-correct-horse-9';
    const fresh = await login(saraPassword);                    // login 3
    expect(fresh.statusCode).toBe(200);
    saraCookie = cookieOf(fresh);
  });

  it('deactivating kills the live session and blocks login until reactivation', async () => {
    expect((await me(saraCookie)).statusCode).toBe(200);

    const off = await patch(saraId, { isActive: false }, a.cookie);
    expect(off.statusCode).toBe(200);
    expect(off.json().isActive).toBe(false);
    expect((await me(saraCookie)).statusCode).toBe(401);
    const denied = await login(saraPassword);                   // login 4
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe('invalid_credentials');

    const on = await patch(saraId, { isActive: true }, a.cookie);
    expect(on.json().isActive).toBe(true);
    const back = await login(saraPassword);                     // login 5
    expect(back.statusCode).toBe(200);
    saraCookie = cookieOf(back);
  });

  it('refuses to deactivate or demote the last active owner', async () => {
    const off = await patch(a.userId, { isActive: false }, a.cookie);
    expect(off.statusCode).toBe(409);
    expect(off.json().error.code).toBe('last_owner');
    const demote = await patch(a.userId, { role: 'accountant' }, a.cookie);
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe('last_owner');
  });

  it('an accountant cannot create users and duplicate emails are refused', async () => {
    const forbidden = await post('/api/users', { email: 'x@firma-u.mk', firstName: 'X', lastName: 'Y', role: 'readonly' }, saraCookie);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('forbidden');
    expect((await users(saraCookie)).statusCode).toBe(200);

    const dup = await post('/api/users', { email: 'sara@firma-u.mk', firstName: 'С', lastName: 'С', role: 'readonly' }, a.cookie);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('email_taken');
  });

  it('reset-password issues a new temporary password and drops the old sessions', async () => {
    const res = await post(`/api/users/${saraId}/reset-password`, {}, a.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().temporaryPassword).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);
    expect(res.json().temporaryPassword).not.toBe(saraPassword);
    expect((await me(saraCookie)).statusCode).toBe(401);
    saraPassword = res.json().temporaryPassword;
    expect((await login(saraPassword)).statusCode).toBe(200);   // login 6
  });

  it('a user of another organization is not found', async () => {
    const b = await registerTenant(t.app, 'firma-u-2');
    const res = await patch(saraId, { role: 'readonly' }, b.cookie);
    expect(res.statusCode).toBe(404);
    expect((await users(b.cookie)).json().rows).toHaveLength(1);
  });
});
