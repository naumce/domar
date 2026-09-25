import { schema } from '@domar/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { createStaffUser, registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';
import type { NewNotification } from '../src/notifications/repo.js';

describe('notification bells', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let ownerCookie = '';
  let accountantCookie = '';

  const staffPost = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const staffGet = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const portalGet = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? ownerCookie } });
  const portalPost = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? ownerCookie }, payload });

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json', VAPID_PUBLIC_KEY: 'BPublic', VAPID_PRIVATE_KEY: 'memory' });
    a = await registerTenant(t.app, 'firma-nt');
    b = await registerTenant(t.app, 'firma-nt2');
    A = await setupPublishedBuilding(t.app, a.cookie);
    const code = (await staffPost(`/api/contacts/${A.owners.O1}/portal-invite`)).json().code;
    const reg = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code, email: 'o1@nt.mk', password: 'correct-horse-1' } });
    expect(reg.statusCode, reg.body).toBe(201);
    ownerCookie = String(reg.headers['set-cookie']).split(';')[0]!;
    accountantCookie = (await createStaffUser(t.app, a.cookie, 'firma-nt', { email: 'acc@firma-nt.mk', firstName: 'A', lastName: 'C', role: 'accountant' })).cookie;
  });
  afterAll(async () => { await t.close(); });

  it('publishes the VAPID public key to the portal and nothing else', async () => {
    const res = await portalGet('/api/portal/push/key');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ publicKey: 'BPublic' });
    // The private half is never on the wire.
    expect(res.body).not.toContain('memory');
  });

  it('stores one subscription per endpoint and updates it in place', async () => {
    const body = { endpoint: 'https://push.example/e1', p256dh: 'k1', auth: 'a1' };
    expect((await portalPost('/api/portal/push/subscribe', body)).statusCode).toBe(204);
    expect((await portalPost('/api/portal/push/subscribe', { ...body, p256dh: 'k2' })).statusCode).toBe(204);
    const rows = await t.db.query.pushSubscriptions.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.p256dh).toBe('k2');
  });

  it('unsubscribes the caller’s own endpoint', async () => {
    expect((await portalPost('/api/portal/push/unsubscribe', { endpoint: 'https://push.example/e1' })).statusCode).toBe(204);
    expect(await t.db.query.pushSubscriptions.findMany()).toHaveLength(0);
    // Re-subscribed for the tasks that follow.
    await portalPost('/api/portal/push/subscribe', { endpoint: 'https://push.example/e1', p256dh: 'k1', auth: 'a1' });
  });

  it('gives a manager only their own rows, newest first, with an unread count', async () => {
    const { notify, notifyStaff } = await import('../src/notifications/repo.js');
    const ctx = { tenantId: a.tenantId, userId: null, role: 'owner' as const };
    await notify(t.db, ctx, [
      { userId: a.userId, kind: 'maintenance_request_created', title: 'Прво', body: '', link: '/app' },
      { userId: a.userId, kind: 'delivery_failed', title: 'Второ', body: '', link: '/app' },
    ]);
    await notifyStaff(t.db, { tenantId: b.tenantId, userId: null, role: 'owner' }, { kind: 'delivery_failed', what: 'нешто', notificationId: 'n-x' });

    const mine = await staffGet('/api/notifications');
    expect(mine.statusCode).toBe(200);
    const body = mine.json();
    expect(body.rows.map((r: { title: string }) => r.title)).toEqual(['Второ', 'Прво']);
    expect(body.unread).toBe(2);
    // The accountant of the same tenant has rows of their own, not the owner's.
    expect((await staffGet('/api/notifications', accountantCookie)).json().rows).toHaveLength(0);
  });

  it('marks one row read, and refuses somebody else’s id with a 404', async () => {
    const id = (await staffGet('/api/notifications')).json().rows[0].id;
    expect((await staffPost(`/api/notifications/${id}/read`)).statusCode).toBe(204);
    const after = (await staffGet('/api/notifications')).json();
    expect(after.unread).toBe(1);
    expect((await staffPost(`/api/notifications/${id}/read`, {}, accountantCookie)).statusCode).toBe(404);
  });

  it('marks everything read at once', async () => {
    expect((await staffPost('/api/notifications/read-all')).statusCode).toBe(204);
    expect((await staffGet('/api/notifications')).json().unread).toBe(0);
  });

  it('breaks a created_at tie by insertion order, not by chance', async () => {
    const { notify } = await import('../src/notifications/repo.js');
    const ctx = { tenantId: a.tenantId, userId: null, role: 'owner' as const };
    // Two rows from one notify() call, then a third from a second notify() call in the same
    // transaction: all three share `created_at` (`now()` is fixed for the whole transaction), so
    // only `seq` can tell them apart.
    await t.db.transaction(async (tx) => {
      await notify(tx, ctx, [
        { userId: a.userId, kind: 'delivery_failed', title: 'Прва', body: '', link: '/app' },
        { userId: a.userId, kind: 'delivery_failed', title: 'Втора', body: '', link: '/app' },
      ]);
      await notify(tx, ctx, [
        { userId: a.userId, kind: 'delivery_failed', title: 'Трета', body: '', link: '/app' },
      ]);
    });
    const titles = (await staffGet('/api/notifications')).json().rows.map((r: { title: string }) => r.title);
    expect(titles.slice(0, 3)).toEqual(['Трета', 'Втора', 'Прва']);
  });

  it('gives an owner their own rows across every link, and never a staff row', async () => {
    const { notify } = await import('../src/notifications/repo.js');
    const account = (await portalGet('/api/portal/me')).json().account.id;
    await notify(t.db, { tenantId: a.tenantId, userId: null, role: 'readonly' }, [
      { ownerAccountId: account, kind: 'invoice_published', title: 'Нова фактура', body: 'Вкупно: 2.450,00 ден.', link: '/portal/invoices/x' },
    ]);
    const res = await portalGet('/api/portal/notifications');
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.map((r: { title: string }) => r.title)).toEqual(['Нова фактура']);
    expect(res.json().unread).toBe(1);
    // The body is readable behind the session — it is only the *push* that may not carry an amount.
    expect(res.json().rows[0].body).toContain('2.450,00 ден.');
    const id = res.json().rows[0].id;
    expect((await portalPost(`/api/portal/notifications/${id}/read`)).statusCode).toBe(204);
    expect((await portalGet('/api/portal/notifications')).json().unread).toBe(0);
  });

  it('marks everything read at once for the owner too', async () => {
    const { notify } = await import('../src/notifications/repo.js');
    const account = (await portalGet('/api/portal/me')).json().account.id;
    await notify(t.db, { tenantId: a.tenantId, userId: null, role: 'readonly' }, [
      { ownerAccountId: account, kind: 'invoice_published', title: 'Втора фактура', body: '', link: '/portal/invoices/y' },
      { ownerAccountId: account, kind: 'invoice_published', title: 'Трета фактура', body: '', link: '/portal/invoices/z' },
    ]);
    expect((await portalGet('/api/portal/notifications')).json().unread).toBe(2);
    expect((await portalPost('/api/portal/notifications/read-all')).statusCode).toBe(204);
    expect((await portalGet('/api/portal/notifications')).json().unread).toBe(0);
  });

  it('a revoked link makes a row unreachable for reading and unmarkable, not merely invisible', async () => {
    // A second link, in another tenant, so the account keeps its session once tenant a's link is gone
    // (`deletePortalLink` drops the owner's sessions only once it holds no link at all).
    const contactB = (await t.app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie: b.cookie }, payload: { firstName: 'Тест', lastName: 'Б' } })).json().id;
    const codeB = (await t.app.inject({ method: 'POST', url: `/api/contacts/${contactB}/portal-invite`, headers: { cookie: b.cookie } })).json().code;
    expect((await portalPost('/api/portal/link', { code: codeB })).statusCode).toBe(201);

    const { notify } = await import('../src/notifications/repo.js');
    const account = (await portalGet('/api/portal/me')).json().account.id;
    await notify(t.db, { tenantId: a.tenantId, userId: null, role: 'readonly' }, [
      { ownerAccountId: account, kind: 'invoice_published', title: 'Пред откажан линк', body: '', link: '/portal/invoices/revoked' },
    ]);
    const row = (await portalGet('/api/portal/notifications')).json().rows.find((r: { title: string }) => r.title === 'Пред откажан линк');
    expect(row).toBeDefined();

    expect((await t.app.inject({ method: 'DELETE', url: `/api/contacts/${A.owners.O1}/portal-link`, headers: { cookie: a.cookie } })).statusCode).toBe(204);

    // Invisible...
    expect((await portalGet('/api/portal/notifications')).json().rows.map((r: { title: string }) => r.title)).not.toContain('Пред откажан линк');
    // ...and not merely invisible: a direct mark 404s, and a bulk mark-all leaves it untouched.
    expect((await portalPost(`/api/portal/notifications/${row.id}/read`)).statusCode).toBe(404);
    expect((await portalPost('/api/portal/notifications/read-all')).statusCode).toBe(204);
    const [stored] = await t.db.select().from(schema.notifications).where(eq(schema.notifications.id, row.id));
    expect(stored!.readAt).toBeNull();
  });

  it('does not accept a staff cookie on the portal bell, nor an owner cookie on the manager bell', async () => {
    expect((await portalGet('/api/portal/notifications', a.cookie)).statusCode).toBe(401);
    expect((await staffGet('/api/notifications', ownerCookie)).statusCode).toBe(401);
  });
});

/**
 * Compile-time only: `notify` takes exactly one recipient. These lines fail the build if the union
 * ever loosens back into two optional fields, which would leave `notifications_recipient_chk` to
 * report a trigger's bug as a 500 at run time.
 */
describe('the recipient union', () => {
  it('refuses both recipients and refuses neither', () => {
    const body = { kind: 'invoice_published', title: 'т', body: 'т', link: '/portal' } as const;
    const owner: NewNotification = { ...body, ownerAccountId: 'a' };
    const staff: NewNotification = { ...body, userId: 'u' };
    // @ts-expect-error both recipients
    const both: NewNotification = { ...body, ownerAccountId: 'a', userId: 'u' };
    // @ts-expect-error no recipient
    const neither: NewNotification = { ...body };
    expect([owner, staff, both, neither]).toHaveLength(4);
  });
});
