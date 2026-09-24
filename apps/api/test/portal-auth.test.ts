import { schema } from '@domar/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteOwnerSessionsFor } from '../src/portal/session.js';
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

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string, ip?: string) =>
    t.app.inject({ method: 'POST', url, headers: cookie ? { cookie } : {}, payload, ...(ip ? { remoteAddress: ip } : {}) });
  const get = (url: string, cookie: string) => t.app.inject({ method: 'GET', url, headers: { cookie } });
  const staffPost = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const del = (contactId: string, cookie?: string) =>
    t.app.inject({ method: 'DELETE', url: `/api/contacts/${contactId}/portal-link`, headers: { cookie: cookie ?? a.cookie } });
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
    const staffInPortal = await get('/api/portal/me', a.cookie);
    expect(staffInPortal.statusCode).toBe(401);
    expect(staffInPortal.json().error.code).toBe('unauthorized');
    // …and an owner cookie buys nothing in the manager app.
    for (const url of ['/api/contacts', '/api/auth/me']) {
      const res = await get(url, ownerCookie);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
    }
  });

  it('reads only its own cookie when a request carries both', async () => {
    const login = await post('/api/portal/login', { email: 'marko@owner.mk', password: 'correct-horse-1' }, undefined, '10.9.0.4');
    const both = `${a.cookie}; ${cookieOf(login)}`;
    const portalMe = await get('/api/portal/me', both);
    expect(portalMe.statusCode).toBe(200);
    expect(portalMe.json().account.email).toBe('marko@owner.mk');
    const staffMe = await get('/api/auth/me', both);
    expect(staffMe.statusCode).toBe(200);
    expect(staffMe.json().user.id).toBe(a.userId);
  });

  it('checks the code before the account, so a bad code cannot reveal a registered email', async () => {
    const ip = '10.9.0.1';
    for (const email of ['marko@owner.mk', 'ghost@owner.mk']) {
      const res = await post('/api/portal/register', { code: 'ZZZZZZZZ', email, password: 'nope-nope-nope' }, undefined, ip);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_code');
    }
  });

  it('refuses a valid code against a deactivated account without burning it', async () => {
    const ip = '10.9.0.3';
    const contact = (await staffPost('/api/contacts', { firstName: 'Втора', lastName: 'Шанса' })).json().id;
    const code = await codeFor(contact);
    const res = await post('/api/portal/register', { code, email: 'off@owner.mk', password: 'correct-horse-1' }, undefined, ip);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_credentials');
    const invites = await t.db.select().from(schema.portalInvites).where(eq(schema.portalInvites.contactId, contact));
    expect(invites[0]!.usedAt).toBeNull();
  });

  it('refuses a code whose contact already belongs to another account', async () => {
    const ip = '10.9.0.2';
    const shared = (await staffPost('/api/contacts', { firstName: 'Спор', lastName: 'Имот' })).json().id;
    expect((await post('/api/portal/register', { code: await codeFor(shared), email: 'first@owner.mk', password: 'correct-horse-1' }, undefined, ip)).statusCode).toBe(201);

    // …at registration…
    const viaRegister = await post('/api/portal/register', { code: await codeFor(shared), email: 'second@owner.mk', password: 'correct-horse-1' }, undefined, ip);
    expect(viaRegister.statusCode).toBe(409);
    expect(viaRegister.json().error.code).toBe('contact_already_linked');
    expect(await t.db.select().from(schema.ownerAccounts).where(eq(schema.ownerAccounts.email, 'second@owner.mk'))).toHaveLength(0);

    // …and on /link from a second account.
    const own = (await staffPost('/api/contacts', { firstName: 'Свој', lastName: 'Имот' })).json().id;
    const other = await post('/api/portal/register', { code: await codeFor(own), email: 'second@owner.mk', password: 'correct-horse-1' }, undefined, ip);
    const viaLink = await post('/api/portal/link', { code: await codeFor(shared) }, cookieOf(other), ip);
    expect(viaLink.statusCode).toBe(409);
    expect(viaLink.json().error.code).toBe('contact_already_linked');

    const invites = await t.db.select().from(schema.portalInvites).where(eq(schema.portalInvites.contactId, shared));
    expect(invites.filter((i) => i.usedAt !== null)).toHaveLength(1); // only the first owner's claim stuck
  });

  it('deleteOwnerSessionsFor drops every session of one account', async () => {
    const ip = '10.9.0.5';
    const one = cookieOf(await post('/api/portal/login', { email: 'first@owner.mk', password: 'correct-horse-1' }, undefined, ip));
    const two = cookieOf(await post('/api/portal/login', { email: 'first@owner.mk', password: 'correct-horse-1' }, undefined, ip));
    expect((await get('/api/portal/me', one)).statusCode).toBe(200);
    const [account] = await t.db.select().from(schema.ownerAccounts).where(eq(schema.ownerAccounts.email, 'first@owner.mk'));
    await deleteOwnerSessionsFor(t.db, account!.id);
    for (const cookie of [one, two]) expect((await get('/api/portal/me', cookie)).statusCode).toBe(401);
  });

  it('unlinks a contact, keeps the account’s other links and 404s that contact’s portal data', async () => {
    const ip = '10.9.0.6';
    const one = (await staffPost('/api/contacts', { firstName: 'Прв', lastName: 'Имот' })).json().id;
    const two = (await staffPost('/api/contacts', { firstName: 'Втор', lastName: 'Имот' })).json().id;
    const cookie = cookieOf(await post('/api/portal/register', { code: await codeFor(one), email: 'two-links@owner.mk', password: 'correct-horse-1' }, undefined, ip));
    expect((await post('/api/portal/link', { code: await codeFor(two) }, cookie, ip)).statusCode).toBe(201);

    expect((await del(one)).statusCode).toBe(204);
    expect((await get(`/api/portal/invoices?contactId=${one}`, cookie)).statusCode).toBe(404);
    expect((await get(`/api/portal/invoices?contactId=${two}`, cookie)).statusCode).toBe(200);
    expect((await get('/api/portal/me', cookie)).json().links).toHaveLength(1);
    expect((await get(`/api/contacts/${one}/portal-status`, a.cookie)).json()).toEqual({ status: 'none' });

    const audit = await t.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'portal_link.delete'));
    expect(audit).toHaveLength(1);
    expect(audit[0]!).toMatchObject({ tenantId: a.tenantId, userId: a.userId, entityType: 'contact', entityId: one });
    expect(JSON.stringify(audit[0]!.before)).not.toContain('@'); // ids only, never the owner's email

    expect((await del(one)).statusCode).toBe(404); // nothing left to unlink
  });

  it('drops the owner’s sessions when the unlinked contact was their last link', async () => {
    const ip = '10.9.0.7';
    const solo = (await staffPost('/api/contacts', { firstName: 'Сам', lastName: 'Имот' })).json().id;
    const cookie = cookieOf(await post('/api/portal/register', { code: await codeFor(solo), email: 'solo@owner.mk', password: 'correct-horse-1' }, undefined, ip));
    expect((await get('/api/portal/me', cookie)).statusCode).toBe(200);
    const [account] = await t.db.select().from(schema.ownerAccounts).where(eq(schema.ownerAccounts.email, 'solo@owner.mk'));

    expect((await del(solo)).statusCode).toBe(204);
    expect(await t.db.select().from(schema.ownerSessions).where(eq(schema.ownerSessions.ownerAccountId, account!.id))).toHaveLength(0);
    expect((await get('/api/portal/me', cookie)).statusCode).toBe(401);
  });

  it('checks the tenant and the role on the unlink', async () => {
    const ip = '10.9.0.8';
    const mine = (await staffPost('/api/contacts', { firstName: 'Рола', lastName: 'Проверка' })).json().id;
    expect((await post('/api/portal/register', { code: await codeFor(mine), email: 'roles@owner.mk', password: 'correct-horse-1' }, undefined, ip)).statusCode).toBe(201);
    expect((await del(markoB)).statusCode).toBe(404); // the other manager's contact, linked or not

    const staffCookie = async (email: string, role: string) => {
      const created = (await staffPost('/api/users', { email, firstName: 'У', lastName: 'Службеник', role })).json();
      return cookieOf(await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: 'firma-pa', email, password: created.temporaryPassword } }));
    };
    expect((await del(mine, await staffCookie('tech@firma-pa.mk', 'technician'))).statusCode).toBe(403);
    expect((await del(mine, await staffCookie('acc@firma-pa.mk', 'accountant'))).statusCode).toBe(204);
  });

  it('throttles repeated portal login attempts', async () => {
    // The earlier tests already spent part of this route's budget, so assert that the limiter fires
    // somewhere in the burst rather than on one particular attempt.
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await post('/api/portal/login', { email: 'flood@owner.mk', password: 'nope-nope-nope' })).statusCode);
    expect(codes).toContain(429);
  });
});
