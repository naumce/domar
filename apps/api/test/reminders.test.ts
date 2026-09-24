import { schema } from '@domar/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Chromium is mocked exactly as in pdf-browser.test.ts: the reminder attachment and the /pdf route
// must be exercised, and no test may depend on a browser being installed.
vi.mock('playwright-core', () => {
  const launch = vi.fn(async () => ({
    isConnected: () => true,
    newContext: async () => ({ newPage: async () => ({ setContent: async () => {}, pdf: async () => Buffer.from('%PDF-reminder') }), close: async () => {} }),
    close: async () => {},
  }));
  return { chromium: { launch } };
});

import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('reminders', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let o1Total = 0;

  interface Row {
    id: string; contactId: string; reason: string; invoiceIds: string[]; invoiceNumbers: string[];
    totalOutstandingMinor: number; channel: string; status: string; sentAt: string | null;
  }

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json', JOB_TOKEN: 'cron-secret' });
    a = await registerTenant(t.app, 'firma-rem');
    b = await registerTenant(t.app, 'firma-other');
    // Building A: 2026-09 and 2026-10, both published with a due date in the past.
    A = await setupPublishedBuilding(t.app, a.cookie, { dueAt: daysAgo(75) });
    await t.app.inject({ method: 'PATCH', url: `/api/contacts/${A.owners.O1}`, headers: { cookie: a.cookie }, payload: { email: 'marko@firma-rem.mk' } });
    const p10 = (await post(`/api/buildings/${A.buildingId}/periods`, { period: '2026-10' })).json().id;
    await post(`/api/buildings/${A.buildingId}/periods/${p10}/generate`);
    await post(`/api/buildings/${A.buildingId}/periods/${p10}/publish`, { dueAt: daysAgo(45) });
    const invoices: { contactId: string; totalMinor: number }[] = (await get(`/api/invoices?buildingId=${A.buildingId}&pageSize=200`)).json().rows;
    o1Total = invoices.filter((r) => r.contactId === A.owners.O1).reduce((s, r) => s + r.totalMinor, 0);
    expect(o1Total).toBeGreaterThan(0);
  });
  afterAll(async () => {
    const m = await import('../src/pdf/html-to-pdf.js');
    await m.closePdfBrowser();
    m._resetForTests();
    await t.close();
  });

  it('creates one reminder per overdue owner with reason consecutive', async () => {
    const res = await post(`/api/buildings/${A.buildingId}/reminders/run`);
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as Row[];
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.reason).toBe('consecutive');
      expect(r.invoiceIds).toHaveLength(2);
      expect(r.invoiceNumbers).toHaveLength(2);
    }
    const o1 = rows.find((r) => r.contactId === A.owners.O1)!;
    expect(o1.totalOutstandingMinor).toBe(o1Total);
    expect(o1.channel).toBe('email');
    expect(o1.status).toBe('sent');
    expect(o1.sentAt).not.toBeNull();
    const o2 = rows.find((r) => r.contactId === A.owners.O2)!;
    expect(o2.channel).toBe('letter');
    expect(o2.status).toBe('pending');
    expect(o2.sentAt).toBeNull();
  });

  it('mails the letter as a PDF attachment and logs it', async () => {
    expect(t.app.mailer.outbox).toHaveLength(1);
    const msg = t.app.mailer.outbox[0]!;
    expect(msg.to).toBe('marko@firma-rem.mk');
    expect(msg.subject).toBe('Опомена за неплатени пресметки — Партизанска 12');
    expect(msg.text).toContain('член 28');
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0]!.contentType).toBe('application/pdf');
    expect(msg.attachments![0]!.filename).toMatch(/^opomena-[0-9a-f-]{36}\.pdf$/);
    expect(msg.attachments![0]!.content.toString()).toBe('%PDF-reminder');
    const logs = await t.db.select().from(schema.emailLog).where(eq(schema.emailLog.tenantId, a.tenantId));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe('sent');
    expect(logs[0]!.template).toBe('reminder');
    expect(logs[0]!.refType).toBe('reminder');
    expect(logs[0]!.toAddress).toBe('marko@firma-rem.mk');
  });

  it('is idempotent inside the 30-day window', async () => {
    const again = await post(`/api/buildings/${A.buildingId}/reminders/run`);
    expect(again.json().rows).toEqual([]);
    const list = await get(`/api/buildings/${A.buildingId}/reminders`);
    expect(list.json().rows).toHaveLength(3);
  });

  it('renders the document with the Art. 28 sentence and no fee', async () => {
    const id = (await get(`/api/buildings/${A.buildingId}/reminders`)).json().rows[0].id;
    const html = await get(`/api/reminders/${id}/html`);
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.body).toContain('член 28');
    expect(html.body).toContain('Опомена');
    expect(html.body).toContain('Партизанска 12');
    expect(html.body).not.toMatch(/надоместок за опомена|казнена камата/i);
    const pdf = await get(`/api/reminders/${id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.toString()).toBe('%PDF-reminder');
  });

  it('marks a letter reminder printed exactly once', async () => {
    const rows = (await get(`/api/buildings/${A.buildingId}/reminders`)).json().rows as Row[];
    const letter = rows.find((r) => r.channel === 'letter')!;
    const first = await post(`/api/reminders/${letter.id}/printed`);
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('printed');
    expect(first.json().sentAt).not.toBeNull();
    const second = await post(`/api/reminders/${letter.id}/printed`);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('not_pending');
  });

  it('uses the total rule for three non-consecutive overdue periods', async () => {
    const B = await setupPublishedBuilding(t.app, a.cookie, { dueAt: daysAgo(200) });
    for (const [period, days] of [['2026-11', 150], ['2027-01', 100]] as const) {
      const p = (await post(`/api/buildings/${B.buildingId}/periods`, { period })).json().id;
      await post(`/api/buildings/${B.buildingId}/periods/${p}/generate`);
      await post(`/api/buildings/${B.buildingId}/periods/${p}/publish`, { dueAt: daysAgo(days) });
    }
    const rows = (await post(`/api/buildings/${B.buildingId}/reminders/run`)).json().rows as Row[];
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.reason).toBe('total');
      expect(r.invoiceIds).toHaveLength(3);
    }
  });

  it('refuses the cron job without a valid token', async () => {
    const none = await t.app.inject({ method: 'POST', url: '/api/jobs/reminders' });
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('unauthorized');
    const wrong = await t.app.inject({ method: 'POST', url: '/api/jobs/reminders', headers: { 'x-job-token': 'nope' } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('forbidden');
  });

  it('runs the cron job over every tenant and creates nothing inside the window', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/jobs/reminders', headers: { 'x-job-token': 'cron-secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenants: 2, buildings: 2, reminders: 0 });
  });

  it('hides another tenant\'s reminders', async () => {
    const list = await get(`/api/buildings/${A.buildingId}/reminders`, b.cookie);
    expect(list.statusCode).toBe(404);
    const id = (await get(`/api/buildings/${A.buildingId}/reminders`)).json().rows[0].id;
    expect((await get(`/api/reminders/${id}/pdf`, b.cookie)).statusCode).toBe(404);
    expect((await post(`/api/reminders/${id}/printed`, {}, b.cookie)).statusCode).toBe(404);
  });
});
