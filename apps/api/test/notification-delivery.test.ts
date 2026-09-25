import { schema } from '@domar/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const TOKEN = 'job-token-for-the-tests';

describe('notification delivery job', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let accountId = '';
  let ownerCookie = '';

  const drain = (token = TOKEN) => t.app.inject({ method: 'POST', url: '/api/jobs/notifications', headers: { 'x-job-token': token } });
  const write = async (over: Partial<typeof schema.notifications.$inferInsert> = {}) => {
    const [row] = await t.db.insert(schema.notifications).values({
      tenantId: a.tenantId, ownerAccountId: accountId, kind: 'invoice_published',
      title: 'Нова фактура · Партизанска 12', body: 'Вкупно: 2.450,00 ден.', link: '/portal/invoices/i-1',
      ...over,
    }).returning();
    return row!;
  };
  const reload = async (id: string) => (await t.db.select().from(schema.notifications).where(eq(schema.notifications.id, id)))[0]!;

  beforeAll(async () => {
    t = await createTestApp({ JOB_TOKEN: TOKEN, SMTP_URL: 'json', VAPID_PUBLIC_KEY: 'BPublic', VAPID_PRIVATE_KEY: 'memory' });
    a = await registerTenant(t.app, 'firma-nd');
    A = await setupPublishedBuilding(t.app, a.cookie);
    const code = (await t.app.inject({ method: 'POST', url: `/api/contacts/${A.owners.O1}/portal-invite`, headers: { cookie: a.cookie }, payload: {} })).json().code;
    const reg = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code, email: 'o1@nd.mk', password: 'correct-horse-1' } });
    ownerCookie = String(reg.headers['set-cookie']).split(';')[0]!;
    accountId = reg.json().account.id;
    // Clear whatever the fixture's own publish wrote, so each case counts only its own row.
    await t.db.delete(schema.notifications);
  });
  afterAll(async () => { await t.close(); });

  it('answers 401 without a token, 403 with a wrong one', async () => {
    expect((await t.app.inject({ method: 'POST', url: '/api/jobs/notifications' })).statusCode).toBe(401);
    expect((await drain('nope-nope-nope-nope')).statusCode).toBe(403);
  });

  it('pushes title and link only, and never the amount', async () => {
    await t.app.inject({
      method: 'POST', url: '/api/portal/push/subscribe', headers: { cookie: ownerCookie },
      payload: { contactId: A.owners.O1, endpoint: 'https://push.example/live', p256dh: 'k', auth: 'x' },
    });
    const row = await write();
    const res = await drain();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ claimed: 1, pushed: 1, emailed: 0, failed: 0 });

    expect(t.app.pusher.sent).toHaveLength(1);
    expect(t.app.pusher.sent[0]!.payload).toEqual({ id: row.id, title: row.title, link: row.link });
    expect(JSON.stringify(t.app.pusher.sent[0]!.payload)).not.toContain('ден.');
    const after = await reload(row.id);
    expect(after.deliveredAt).not.toBeNull();
    expect(after.deliveryError).toBeNull();
    // No second send on a second run: the claim is what makes the job idempotent.
    expect((await drain()).json()).toEqual({ claimed: 0, pushed: 0, emailed: 0, failed: 0 });
  });

  it('falls back to email when the account has no subscription', async () => {
    await t.db.delete(schema.pushSubscriptions);
    const row = await write();
    expect((await drain()).json()).toEqual({ claimed: 1, pushed: 0, emailed: 1, failed: 0 });
    const sent = t.app.mailer.outbox.at(-1)!;
    expect(sent.to).toBe('o1@nd.mk');
    expect(sent.subject).toBe(row.title);
    // Email is behind an address the owner already gave us, so it may carry the detail.
    expect(sent.text).toContain('2.450,00 ден.');
    expect((await reload(row.id)).deliveryError).toBeNull();
  });

  it('deletes a subscription the push service reports as gone', async () => {
    await t.db.insert(schema.pushSubscriptions).values({
      ownerAccountId: accountId, endpoint: 'https://push.example/gone', p256dh: 'k', auth: 'x',
    });
    const original = t.app.pusher.send;
    (t.app.pusher as { send: unknown }).send = async () => ({ ok: false, error: 'gone', gone: true });
    try {
      await write();
      // Push is gone, so the email fallback carries it.
      expect((await drain()).json()).toEqual({ claimed: 1, pushed: 0, emailed: 1, failed: 0 });
    } finally {
      (t.app.pusher as { send: unknown }).send = original;
    }
    expect(await t.db.select().from(schema.pushSubscriptions)).toHaveLength(0);
  });

  it('rings the manager’s bell when neither push nor email delivered', async () => {
    const noMail = await createTestApp({ JOB_TOKEN: TOKEN }); // no SMTP_URL, no VAPID
    try {
      const x = await registerTenant(noMail.app, 'firma-nd2');
      const X = await setupPublishedBuilding(noMail.app, x.cookie);
      const code = (await noMail.app.inject({ method: 'POST', url: `/api/contacts/${X.owners.O1}/portal-invite`, headers: { cookie: x.cookie }, payload: {} })).json().code;
      const reg = await noMail.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code, email: 'o1@nd2.mk', password: 'correct-horse-1' } });
      await noMail.db.delete(schema.notifications);
      await noMail.db.insert(schema.notifications).values({
        tenantId: x.tenantId, ownerAccountId: reg.json().account.id, kind: 'invoice_published',
        title: 'Нова фактура', body: 'Вкупно: 1,00 ден.', link: '/portal/invoices/i-9',
      });
      const res = await noMail.app.inject({ method: 'POST', url: '/api/jobs/notifications', headers: { 'x-job-token': TOKEN } });
      expect(res.json()).toEqual({ claimed: 1, pushed: 0, emailed: 0, failed: 1 });

      const bell = await noMail.db.select().from(schema.notifications)
        .where(and(eq(schema.notifications.tenantId, x.tenantId), eq(schema.notifications.userId, x.userId)));
      expect(bell).toHaveLength(1);
      expect(bell[0]!.kind).toBe('delivery_failed');
      expect(bell[0]!.title).toBe('Известувањето не беше испорачано');
      // The staff row itself is delivered by the same run that created it? No: it is marked
      // delivered without a network call the *next* time the job runs, and never emailed.
      const second = await noMail.app.inject({ method: 'POST', url: '/api/jobs/notifications', headers: { 'x-job-token': TOKEN } });
      expect(second.json()).toEqual({ claimed: 1, pushed: 0, emailed: 0, failed: 0 });
      expect(noMail.app.mailer.outbox).toHaveLength(0);
    } finally {
      await noMail.close();
    }
  });
});
