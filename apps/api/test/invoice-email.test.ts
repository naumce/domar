import { schema } from '@domar/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('playwright-core', () => {
  const launch = vi.fn(async () => ({
    isConnected: () => true,
    newContext: async () => ({ newPage: async () => ({ setContent: async () => {}, pdf: async () => Buffer.from('%PDF-invoice') }), close: async () => {} }),
    close: async () => {},
  }));
  return { chromium: { launch } };
});

import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('invoice email', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let F: Awaited<ReturnType<typeof setupPublishedBuilding>>;

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-mail2');
    b = await registerTenant(t.app, 'firma-mail3');
    F = await setupPublishedBuilding(t.app, a.cookie);
    await t.app.inject({ method: 'PATCH', url: `/api/contacts/${F.owners.O1}`, headers: { cookie: a.cookie }, payload: { email: 'ana@firma-mail2.mk' } });
  });
  afterAll(async () => {
    const m = await import('../src/pdf/html-to-pdf.js');
    await m.closePdfBrowser();
    m._resetForTests();
    await t.close();
  });

  it('emails one invoice with the PDF attached and logs it', async () => {
    const res = await post(`/api/invoices/${F.invoices.O1.id}/send`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: F.invoices.O1.id, status: 'sent', to: 'ana@firma-mail2.mk', error: null });
    const msg = t.app.mailer.outbox.at(-1)!;
    expect(msg.to).toBe('ana@firma-mail2.mk');
    expect(msg.subject).toBe(`Фактура ${F.invoices.O1.number} — Партизанска 12`);
    expect(msg.attachments![0]!.filename).toBe(`${F.invoices.O1.number.replace(/[^A-Za-z0-9_.-]/g, '_')}.pdf`);
    expect(msg.attachments![0]!.contentType).toBe('application/pdf');
    expect(msg.attachments![0]!.content.toString()).toBe('%PDF-invoice');
    const logs = await t.db.select().from(schema.emailLog)
      .where(and(eq(schema.emailLog.tenantId, a.tenantId), eq(schema.emailLog.refId, F.invoices.O1.id)));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe('sent');
    expect(logs[0]!.template).toBe('invoice');
    expect(logs[0]!.toAddress).toBe('ana@firma-mail2.mk');
  });

  it('refuses an owner without an email', async () => {
    const res = await post(`/api/invoices/${F.invoices.O2.id}/send`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('no_email');
  });

  it('sends the whole period and counts the owners without an email', async () => {
    const before = t.app.mailer.outbox.length;
    const res = await post(`/api/buildings/${F.buildingId}/periods/${F.periodId}/send`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: 1, failed: 0, skipped: 2 });
    expect(t.app.mailer.outbox.length).toBe(before + 1);
  });

  it('is 404 for another tenant', async () => {
    expect((await post(`/api/invoices/${F.invoices.O1.id}/send`, {}, b.cookie)).statusCode).toBe(404);
    expect((await post(`/api/buildings/${F.buildingId}/periods/${F.periodId}/send`, {}, b.cookie)).statusCode).toBe(404);
  });

  it('never aborts the batch when one owner\'s send throws', async () => {
    await t.app.inject({ method: 'PATCH', url: `/api/contacts/${F.owners.O2}`, headers: { cookie: a.cookie }, payload: { email: 'bosko@firma-mail2.mk' } });
    await t.app.inject({ method: 'PATCH', url: `/api/contacts/${F.owners.O3}`, headers: { cookie: a.cookie }, payload: { email: 'velko@firma-mail2.mk' } });
    const original = t.app.mailer.send.bind(t.app.mailer);
    t.app.mailer.send = (async (msg) => {
      if (msg.to === 'bosko@firma-mail2.mk') throw new Error('smtp exploded');
      return original(msg);
    }) as typeof t.app.mailer.send;
    try {
      const res = await post(`/api/buildings/${F.buildingId}/periods/${F.periodId}/send`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sent: 2, failed: 1, skipped: 0 });
    } finally {
      t.app.mailer.send = original;
    }
  });
});
