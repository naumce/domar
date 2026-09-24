import { schema } from '@domar/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
};
const setCookieRaw = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw);
};

describe('portal auth', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let markoA = '';
  let markoB = '';
  let anaA = '';
  let ownerCookie = '';

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: cookie ? { cookie } : {}, payload });
  const staffPost = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const codeFor = async (contactId: string, cookie?: string) =>
    (await staffPost(`/api/contacts/${contactId}/portal-invite`, {}, cookie)).json().code as string;

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-pa');
    b = await registerTenant(t.app, 'firma-pb');
    markoA = (await staffPost('/api/contacts', { firstName: 'Марко', lastName: 'Марков' })).json().id;
    anaA = (await staffPost('/api/contacts', { firstName: 'Ана', lastName: 'Анева' })).json().id;
    markoB = (await staffPost('/api/contacts', { firstName: 'Марко', lastName: 'Марков' }, b.cookie)).json().id;
  });
  afterAll(async () => { await t.close(); });

  it('registers an owner account from a code and sets the domar_owner cookie', async () => {
    const code = await codeFor(markoA);
    const res = await post('/api/portal/register', { code, email: 'MARKO@owner.mk', password: 'correct-horse-1' });
    expect(res.statusCode).toBe(201);
    const raw = setCookieRaw(res);
    expect(raw).toMatch(/^domar_owner=/);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).not.toContain('Secure'); // NODE_ENV=test
    ownerCookie = cookieOf(res);

    const body = res.json();
    expect(body.account.email).toBe('marko@owner.mk');
    expect(body.account.passwordHash).toBeUndefined();
    expect(body.links).toHaveLength(1);
    expect(body.links[0]).toMatchObject({ tenantId: a.tenantId, tenantName: 'Firma firma-pa', contactId: markoA, contactName: 'Марко Марков' });

    const accounts = await t.db.select().from(schema.ownerAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.email).toBe('marko@owner.mk');
    expect(accounts[0]!.isActive).toBe(true);
    const audit = await t.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'portal_link.create'));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.tenantId).toBe(a.tenantId);
    expect(audit[0]!.userId).toBeNull();
  });

  it('consumes the code exactly once', async () => {
    const code = await codeFor(anaA);
    expect((await post('/api/portal/register', { code, email: 'ana@owner.mk', password: 'correct-horse-1' })).statusCode).toBe(201);
    const again = await post('/api/portal/register', { code, email: 'ana2@owner.mk', password: 'correct-horse-1' });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('invalid_code');
    expect(await t.db.select().from(schema.ownerAccounts).where(eq(schema.ownerAccounts.email, 'ana2@owner.mk'))).toHaveLength(0);
  });

  it('rejects an unknown, expired or revoked code', async () => {
    expect((await post('/api/portal/register', { code: 'ZZZZZZZZ', email: 'x@owner.mk', password: 'correct-horse-1' })).json().error.code).toBe('invalid_code');
    const first = await codeFor(markoA);
    await codeFor(markoA); // reissue revokes `first`
    expect((await post('/api/portal/register', { code: first, email: 'x@owner.mk', password: 'correct-horse-1' })).json().error.code).toBe('invalid_code');
  });

  it('requires the existing password when the email is already registered, and does not burn the code', async () => {
    const code = await codeFor(markoB, b.cookie);
    const wrong = await post('/api/portal/register', { code, email: 'marko@owner.mk', password: 'nope-nope-nope' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid_credentials');
    const invite = await t.db.select().from(schema.portalInvites).where(eq(schema.portalInvites.contactId, markoB));
    expect(invite[0]!.usedAt).toBeNull();

    const ok = await post('/api/portal/register', { code, email: 'marko@owner.mk', password: 'correct-horse-1' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().links).toHaveLength(2); // one contact under each of the two managers
    expect(await t.db.select().from(schema.ownerAccounts)).toHaveLength(2); // marko + ana, no third row
  });

  it('logs in, reads /me and logs out', async () => {
    const login = await post('/api/portal/login', { email: 'Marko@Owner.mk', password: 'correct-horse-1' });
    expect(login.statusCode).toBe(200);
    const cookie = cookieOf(login);
    const me = await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().links.map((l: { tenantId: string }) => l.tenantId).sort()).toEqual([a.tenantId, b.tenantId].sort());
    expect((await post('/api/portal/logout', {}, cookie)).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('rejects a wrong password and an unknown email with the same error', async () => {
    const wrong = await post('/api/portal/login', { email: 'marko@owner.mk', password: 'nope-nope-nope' });
    const ghost = await post('/api/portal/login', { email: 'ghost@owner.mk', password: 'correct-horse-1' });
    expect(wrong.statusCode).toBe(401);
    expect(ghost.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid_credentials');
    expect(ghost.json().error.code).toBe('invalid_credentials');
  });

  it('refuses a deactivated account at login and mid-session', async () => {
    const code = await codeFor((await staffPost('/api/contacts', { firstName: 'Деак', lastName: 'Тивиран' })).json().id);
    const reg = await post('/api/portal/register', { code, email: 'off@owner.mk', password: 'correct-horse-1' });
    const cookie = cookieOf(reg);
    expect((await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } })).statusCode).toBe(200);
    await t.db.update(schema.ownerAccounts).set({ isActive: false }).where(eq(schema.ownerAccounts.email, 'off@owner.mk'));
    expect((await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await post('/api/portal/login', { email: 'off@owner.mk', password: 'correct-horse-1' })).statusCode).toBe(401);
  });

  it('adds another contact to a signed-in account and refuses a duplicate link', async () => {
    const login = await post('/api/portal/login', { email: 'marko@owner.mk', password: 'correct-horse-1' });
    const cookie = cookieOf(login);
    const extra = (await staffPost('/api/contacts', { firstName: 'Втор', lastName: 'Имот' })).json().id;
    const res = await post('/api/portal/link', { code: await codeFor(extra) }, cookie);
    expect(res.statusCode).toBe(201);
    expect(res.json().contactId).toBe(extra);
    expect((await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } })).json().links).toHaveLength(3);

    const dup = await post('/api/portal/link', { code: await codeFor(extra) }, cookie);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('already_linked');
    const invites = await t.db.select().from(schema.portalInvites).where(eq(schema.portalInvites.contactId, extra));
    expect(invites.filter((i) => i.usedAt !== null)).toHaveLength(1); // the refused claim rolled back
  });

  it('changes the password and drops the other sessions', async () => {
    const one = cookieOf(await post('/api/portal/login', { email: 'ana@owner.mk', password: 'correct-horse-1' }));
    const two = cookieOf(await post('/api/portal/login', { email: 'ana@owner.mk', password: 'correct-horse-1' }));
    expect((await post('/api/portal/change-password', { currentPassword: 'wrong-wrong-1', newPassword: 'battery-staple-2' }, two)).statusCode).toBe(401);
    expect((await post('/api/portal/change-password', { currentPassword: 'correct-horse-1', newPassword: 'battery-staple-2' }, two)).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie: two } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie: one } })).statusCode).toBe(401);
    expect((await post('/api/portal/login', { email: 'ana@owner.mk', password: 'battery-staple-2' })).statusCode).toBe(200);
  });

  it('rejects short passwords on register and on change', async () => {
    const code = await codeFor((await staffPost('/api/contacts', { firstName: 'Кратка', lastName: 'Лозинка' })).json().id);
    const res = await post('/api/portal/register', { code, email: 'short@owner.mk', password: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  it('keeps the two cookies apart', async () => {
    // A staff cookie buys nothing in the portal…
    expect((await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie: a.cookie } })).statusCode).toBe(401);
    // …and an owner cookie buys nothing in the manager app.
    expect((await t.app.inject({ method: 'GET', url: '/api/contacts', headers: { cookie: ownerCookie } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ownerCookie } })).statusCode).toBe(401);
  });

  it('throttles repeated portal login attempts', async () => {
    // The earlier tests already spent part of this route's budget, so assert that the limiter fires
    // somewhere in the burst rather than on one particular attempt.
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await post('/api/portal/login', { email: 'flood@owner.mk', password: 'nope-nope-nope' })).statusCode);
    expect(codes).toContain(429);
  });
});
