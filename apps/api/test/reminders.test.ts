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

interface Row {
  id: string; contactId: string; reason: string; invoiceIds: string[]; invoiceNumbers: string[];
  totalOutstandingMinor: number; channel: string; status: string; sentAt: string | null;
}

describe('reminders', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let o1Total = 0;

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json', JOB_TOKEN: 'cron-secret-0123456789' });
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
    // One line per covered invoice, so the debt is itemised even when the PDF fails to render.
    expect(msg.text.match(/INV-\d{4}\/\d{4} · \d{4}-\d{2} · рок: /g)).toHaveLength(2);
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
    const res = await t.app.inject({ method: 'POST', url: '/api/jobs/reminders', headers: { 'x-job-token': 'cron-secret-0123456789' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenants: 2, buildings: 2, reminders: 0, failed: 0 });
  });

  it('hides another tenant\'s reminders', async () => {
    const list = await get(`/api/buildings/${A.buildingId}/reminders`, b.cookie);
    expect(list.statusCode).toBe(404);
    const id = (await get(`/api/buildings/${A.buildingId}/reminders`)).json().rows[0].id;
    expect((await get(`/api/reminders/${id}/pdf`, b.cookie)).statusCode).toBe(404);
    expect((await post(`/api/reminders/${id}/printed`, {}, b.cookie)).statusCode).toBe(404);
  });

  /** Two overdue periods on a fresh building, so each of the three owners is due a reminder. */
  const overdueBuilding = async () => {
    const built = await setupPublishedBuilding(t.app, a.cookie, { dueAt: daysAgo(120) });
    const p = (await post(`/api/buildings/${built.buildingId}/periods`, { period: '2026-10' })).json().id;
    await post(`/api/buildings/${built.buildingId}/periods/${p}/generate`);
    await post(`/api/buildings/${built.buildingId}/periods/${p}/publish`, { dueAt: daysAgo(90) });
    return built;
  };

  it('suppresses on the sent date, not on the creation date', async () => {
    const C = await overdueBuilding();
    expect((await post(`/api/buildings/${C.buildingId}/reminders/run`)).json().rows).toHaveLength(3);
    // A letter created 40 days ago but printed 5 days ago is still a recent reminder: filtering the
    // priors on created_at alone would hide it from the rule and duplicate every reminder.
    await t.db.update(schema.reminders)
      .set({ createdAt: new Date(Date.now() - 40 * 86_400_000), sentAt: new Date(Date.now() - 5 * 86_400_000), status: 'printed' })
      .where(eq(schema.reminders.buildingId, C.buildingId));
    const again = await post(`/api/buildings/${C.buildingId}/reminders/run`);
    expect(again.statusCode).toBe(200);
    expect(again.json().rows).toEqual([]);
  });

  it('serialises two overlapping runs of the same building', async () => {
    const D = await overdueBuilding();
    const [r1, r2] = await Promise.all([
      post(`/api/buildings/${D.buildingId}/reminders/run`),
      post(`/api/buildings/${D.buildingId}/reminders/run`),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect((r1.json().rows as Row[]).length + (r2.json().rows as Row[]).length).toBe(3);
    expect((await get(`/api/buildings/${D.buildingId}/reminders`)).json().rows).toHaveLength(3);
  });

  it('records a rejected send as failed, resends it and prints the other one', async () => {
    const E = await overdueBuilding();
    for (const k of ['O1', 'O2'] as const) {
      await t.app.inject({ method: 'PATCH', url: `/api/contacts/${E.owners[k]}`, headers: { cookie: a.cookie }, payload: { email: `${k.toLowerCase()}@firma-rem.mk` } });
    }
    const send = vi.spyOn(t.app.mailer, 'send').mockResolvedValue({ error: 'connection refused' });
    const rows = (await post(`/api/buildings/${E.buildingId}/reminders/run`)).json().rows as Row[];
    const failed = rows.filter((r) => r.status === 'failed');
    expect(failed).toHaveLength(2);
    for (const r of failed) expect(r.channel).toBe('email');
    send.mockRestore();

    // The retry goes through the same send path, so the row, the email log and the audit all move on.
    const one = failed.find((r) => r.contactId === E.owners.O1)!;
    const resent = await post(`/api/reminders/${one.id}/resend`);
    expect(resent.statusCode).toBe(200);
    expect(resent.json().status).toBe('sent');
    expect(resent.json().error).toBeNull();
    expect(resent.json().sentAt).not.toBeNull();
    expect((await post(`/api/reminders/${one.id}/resend`)).json().error.code).toBe('not_resendable');
    const logs = await t.db.select().from(schema.emailLog).where(eq(schema.emailLog.refId, one.id));
    expect(logs.map((l) => l.status)).toEqual(['failed', 'sent']);

    // The second one is delivered on paper instead.
    const other = failed.find((r) => r.contactId === E.owners.O2)!;
    const printed = await post(`/api/reminders/${other.id}/printed`);
    expect(printed.statusCode).toBe(200);
    expect(printed.json().status).toBe('printed');
  });

  it('refuses to resend a reminder to an owner without an email', async () => {
    const F = await overdueBuilding();
    const send = vi.spyOn(t.app.mailer, 'send').mockResolvedValue({ error: 'connection refused' });
    await t.app.inject({ method: 'PATCH', url: `/api/contacts/${F.owners.O1}`, headers: { cookie: a.cookie }, payload: { email: 'temp@firma-rem.mk' } });
    const rows = (await post(`/api/buildings/${F.buildingId}/reminders/run`)).json().rows as Row[];
    const failed = rows.find((r) => r.status === 'failed')!;
    send.mockRestore();
    await t.app.inject({ method: 'PATCH', url: `/api/contacts/${F.owners.O1}`, headers: { cookie: a.cookie }, payload: { email: null } });
    const res = await post(`/api/reminders/${failed.id}/resend`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('no_email');
    // The rolled-back claim leaves the row failed, so it can still be printed.
    expect((await get(`/api/reminders/${failed.id}/pdf`)).statusCode).toBe(200);
    expect((await post(`/api/reminders/${failed.id}/printed`)).json().status).toBe('printed');
  });

  it('drops a paid invoice and lowers the total by a partial payment', async () => {
    const P = await setupPublishedBuilding(t.app, a.cookie, { dueAt: daysAgo(120) });
    for (const [period, days] of [['2026-10', 90], ['2026-11', 60]] as const) {
      const p = (await post(`/api/buildings/${P.buildingId}/periods`, { period })).json().id;
      await post(`/api/buildings/${P.buildingId}/periods/${p}/generate`);
      await post(`/api/buildings/${P.buildingId}/periods/${p}/publish`, { dueAt: daysAgo(days) });
    }
    const inv = async (period: string) => (await get(`/api/invoices?buildingId=${P.buildingId}&period=${period}&pageSize=200`)).json().rows as { id: string; contactId: string; totalMinor: number }[];
    const [sep, oct, nov] = [await inv('2026-09'), await inv('2026-10'), await inv('2026-11')];
    const of = (rows: { id: string; contactId: string; totalMinor: number }[], k: 'O1' | 'O2') => rows.find((r) => r.contactId === P.owners[k])!;
    const paidAt = new Date().toISOString();
    // O1 settles the oldest invoice; O2 pays 100,00 ден. off theirs.
    await post(`/api/invoices/${of(sep, 'O1').id}/payments`, { amountMinor: of(sep, 'O1').totalMinor, method: 'bank_transfer', paidAt });
    await post(`/api/invoices/${of(sep, 'O2').id}/payments`, { amountMinor: 10000, method: 'cash', paidAt });

    const rows = (await post(`/api/buildings/${P.buildingId}/reminders/run`)).json().rows as Row[];
    const r1 = rows.find((r) => r.contactId === P.owners.O1)!;
    expect(r1.invoiceIds).toHaveLength(2);
    expect(r1.invoiceIds).not.toContain(of(sep, 'O1').id);
    expect(r1.totalOutstandingMinor).toBe(of(oct, 'O1').totalMinor + of(nov, 'O1').totalMinor);
    const r2 = rows.find((r) => r.contactId === P.owners.O2)!;
    expect(r2.invoiceIds).toHaveLength(3);
    expect(r2.totalOutstandingMinor).toBe(of(sep, 'O2').totalMinor + of(oct, 'O2').totalMinor + of(nov, 'O2').totalMinor - 10000);
  });

  it('rate-limits the job route to six calls a minute', async () => {
    // A wrong token is enough: the limit is counted before the handler, so no run is started.
    let last;
    for (let i = 0; i < 7; i++) last = await t.app.inject({ method: 'POST', url: '/api/jobs/reminders', headers: { 'x-job-token': 'nope' } });
    expect(last!.statusCode).toBe(429);
  });
});

/** Same building, but the server has no SMTP_URL: nothing may end up as an undeliverable email row. */
describe('reminders without a configured mailer', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let G: Awaited<ReturnType<typeof setupPublishedBuilding>>;

  const post = (url: string, payload: Record<string, unknown> = {}) => t.app.inject({ method: 'POST', url, headers: { cookie: a.cookie }, payload });

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-nomail');
    G = await setupPublishedBuilding(t.app, a.cookie, { dueAt: daysAgo(120) });
    await t.app.inject({ method: 'PATCH', url: `/api/contacts/${G.owners.O1}`, headers: { cookie: a.cookie }, payload: { email: 'marko@firma-nomail.mk' } });
    const p = (await post(`/api/buildings/${G.buildingId}/periods`, { period: '2026-10' })).json().id;
    await post(`/api/buildings/${G.buildingId}/periods/${p}/generate`);
    await post(`/api/buildings/${G.buildingId}/periods/${p}/publish`, { dueAt: daysAgo(90) });
  });
  afterAll(async () => { await t.close(); });

  it('queues an owner with an email as a printable letter', async () => {
    expect(t.app.mailer.configured).toBe(false);
    const rows = (await post(`/api/buildings/${G.buildingId}/reminders/run`)).json().rows as Row[];
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.channel).toBe('letter');
      expect(r.status).toBe('pending');
    }
    const o1 = rows.find((r) => r.contactId === G.owners.O1)!;
    const printed = await post(`/api/reminders/${o1.id}/printed`);
    expect(printed.statusCode).toBe(200);
    expect(printed.json().status).toBe('printed');
  });
});
