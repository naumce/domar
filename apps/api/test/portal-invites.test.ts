import { schema } from '@domar/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('portal invites', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let withEmail = '';
  let withoutEmail = '';
  let otherTenantContact = '';

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-inv');
    b = await registerTenant(t.app, 'firma-inv2');
    withEmail = (await post('/api/contacts', { firstName: 'Марко', lastName: 'Марков', email: 'marko@firma-inv.mk' })).json().id;
    withoutEmail = (await post('/api/contacts', { firstName: 'Ана', lastName: 'Анева' })).json().id;
    otherTenantContact = (await post('/api/contacts', { firstName: 'Сара', lastName: 'Сарева' }, b.cookie)).json().id;
  });
  afterAll(async () => { await t.close(); });

  it('issues an 8-character code, stores only its hash and emails the owner', async () => {
    const res = await post(`/api/contacts/${withEmail}/portal-invite`);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.code).toMatch(/^[A-HJ-NP-Za-km-z2-9]{8}$/);
    expect(body.emailed).toBe(true);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(13 * 86_400_000);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThan(15 * 86_400_000);

    const rows = await t.db.select().from(schema.portalInvites).where(eq(schema.portalInvites.contactId, withEmail));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).not.toBe(body.code);
    expect(rows[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.tenantId).toBe(a.tenantId);
    expect(rows[0]!.createdBy).toBe(a.userId);
    expect(rows[0]!.usedAt).toBeNull();

    const mail = t.app.mailer.outbox;
    expect(mail).toHaveLength(1);
    expect(mail[0]!.to).toBe('marko@firma-inv.mk');
    expect(mail[0]!.text).toContain(body.code);
    const log = await t.db.select().from(schema.emailLog).where(eq(schema.emailLog.template, 'portal_invite'));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ tenantId: a.tenantId, toAddress: 'marko@firma-inv.mk', status: 'sent', refType: 'contact', refId: withEmail });
  });

  it('never writes the code or its hash into the audit log', async () => {
    const audit = await t.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'portal_invite.create'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.after)).not.toMatch(/[0-9a-f]{64}/);
    expect(audit[0]!.entityType).toBe('contact');
    expect(audit[0]!.entityId).toBe(withEmail);
  });

  it('reports the status as invited while a live code exists', async () => {
    const res = await get(`/api/contacts/${withEmail}/portal-status`);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('invited');
    expect(typeof res.json().expiresAt).toBe('string');
    expect(res.json().linkedAt).toBeUndefined();
  });

  it('reissuing revokes the earlier unused code', async () => {
    const first = (await post(`/api/contacts/${withoutEmail}/portal-invite`)).json();
    const second = (await post(`/api/contacts/${withoutEmail}/portal-invite`)).json();
    expect(second.code).not.toBe(first.code);
    const rows = await t.db.select().from(schema.portalInvites).where(eq(schema.portalInvites.contactId, withoutEmail));
    expect(rows).toHaveLength(2);
    const live = rows.filter((r) => r.usedAt === null && r.expiresAt.getTime() > Date.now());
    expect(live).toHaveLength(1);
    expect(live[0]!.expiresAt.toISOString()).toBe(new Date(second.expiresAt).toISOString());
  });

  it('skips the email when the contact has none', async () => {
    const before = t.app.mailer.outbox.length;
    const res = await post(`/api/contacts/${withoutEmail}/portal-invite`);
    expect(res.json().emailed).toBe(false);
    expect(t.app.mailer.outbox).toHaveLength(before);
  });

  it('reports none for a contact that was never invited', async () => {
    const fresh = (await post('/api/contacts', { firstName: 'Нов', lastName: 'Новески' })).json().id;
    expect((await get(`/api/contacts/${fresh}/portal-status`)).json()).toEqual({ status: 'none' });
  });

  it('404s across tenants for both routes', async () => {
    expect((await post(`/api/contacts/${otherTenantContact}/portal-invite`)).statusCode).toBe(404);
    expect((await get(`/api/contacts/${otherTenantContact}/portal-status`)).statusCode).toBe(404);
  });

  it('requires a write role to issue a code', async () => {
    const created = (await post('/api/users', { email: 'tech@firma-inv.mk', firstName: 'Т', lastName: 'Технички', role: 'technician' })).json();
    const login = await t.app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { tenantSlug: 'firma-inv', email: 'tech@firma-inv.mk', password: created.temporaryPassword },
    });
    const techCookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect((await post(`/api/contacts/${withEmail}/portal-invite`, {}, techCookie)).statusCode).toBe(403);
    // Reading the status is a plain authenticated read.
    expect((await get(`/api/contacts/${withEmail}/portal-status`, techCookie)).statusCode).toBe(200);
  });

  it('requires a session at all', async () => {
    expect((await t.app.inject({ method: 'GET', url: `/api/contacts/${withEmail}/portal-status` })).statusCode).toBe(401);
  });
});
