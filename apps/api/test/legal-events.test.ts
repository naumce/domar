import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Chromium is mocked exactly as in reminders.test.ts: the reminder send renders a PDF attachment and
// no test may depend on a browser being installed.
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

interface EventRow {
  id: string; buildingId: string; kind: string; refType: string; refId: string | null;
  occurredAt: string; dueAt: string | null; evidence: Record<string, unknown>; createdAt: string;
}

describe('legal events', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const events = async (buildingId: string): Promise<EventRow[]> => (await get(`/api/buildings/${buildingId}/legal-events?pageSize=100`)).json().rows;

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-le');
    b = await registerTenant(t.app, 'firma-le-other');
    A = await setupPublishedBuilding(t.app, a.cookie, { dueAt: daysAgo(75) });
    await t.app.inject({ method: 'PATCH', url: `/api/contacts/${A.owners.O1}`, headers: { cookie: a.cookie }, payload: { email: 'marko@firma-le.mk' } });
  });
  afterAll(async () => {
    const m = await import('../src/pdf/html-to-pdf.js');
    await m.closePdfBrowser();
    m._resetForTests();
    await t.close();
  });

  it('publishing a period writes one invoice_published with the invoice ids', async () => {
    const rows = await events(A.buildingId);
    const published = rows.filter((e) => e.kind === 'invoice_published');
    expect(published).toHaveLength(1);
    const e = published[0]!;
    expect(e.refType).toBe('billing_period');
    expect(e.refId).toBe(A.periodId);
    expect(e.dueAt).not.toBeNull();
    expect(e.evidence.period).toBe('2026-09');
    expect(e.evidence.periodKind).toBe('regular');
    expect(e.evidence.invoiceCount).toBe(3);
    expect((e.evidence.invoiceIds as string[]).sort()).toEqual([A.invoices.O1.id, A.invoices.O2.id, A.invoices.O3.id].sort());
    expect(e.evidence.totalMinor).toBe(A.invoices.O1.totalMinor + A.invoices.O2.totalMinor + A.invoices.O3.totalMinor);
  });

  it('a sent reminder writes reminder_sent with the email log id', async () => {
    // A second overdue period puts O1 over the Art. 28 "two consecutive" threshold.
    const p10 = (await post(`/api/buildings/${A.buildingId}/periods`, { period: '2026-10' })).json().id;
    await post(`/api/buildings/${A.buildingId}/periods/${p10}/generate`);
    await post(`/api/buildings/${A.buildingId}/periods/${p10}/publish`, { dueAt: daysAgo(45) });
    const created: { id: string; contactId: string; channel: string; status: string; invoiceIds: string[] }[] =
      (await post(`/api/buildings/${A.buildingId}/reminders/run`)).json().rows;
    const emailed = created.find((r) => r.contactId === A.owners.O1)!;
    expect(emailed.channel).toBe('email');
    expect(emailed.status).toBe('sent');

    const rows = await events(A.buildingId);
    const sent = rows.filter((e) => e.kind === 'reminder_sent' && e.refId === emailed.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.evidence.channel).toBe('email');
    expect(sent[0]!.evidence.contactId).toBe(A.owners.O1);
    expect(sent[0]!.evidence.emailLogId).toEqual(expect.any(String));
    expect((sent[0]!.evidence.invoiceIds as string[]).sort()).toEqual([...emailed.invoiceIds].sort());
    // The second published period wrote its own invoice_published.
    expect(rows.filter((e) => e.kind === 'invoice_published')).toHaveLength(2);
  });

  it('marking a letter printed writes reminder_sent with channel letter and no email log', async () => {
    const letter: { id: string; channel: string; contactId: string } =
      (await get(`/api/buildings/${A.buildingId}/reminders`)).json().rows.find((r: { channel: string }) => r.channel === 'letter');
    expect(letter).toBeDefined();
    await post(`/api/reminders/${letter.id}/printed`);
    const sent = (await events(A.buildingId)).filter((e) => e.kind === 'reminder_sent' && e.refId === letter.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.evidence.channel).toBe('letter');
    expect(sent[0]!.evidence.emailLogId).toBeNull();
  });

  it('the first portal link writes fund_statement_available once per building', async () => {
    const invite = (await post(`/api/contacts/${A.owners.O1}/portal-invite`)).json();
    const res = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code: invite.code, email: 'marko.owner@example.mk', password: 'correct-horse-1' } });
    expect(res.statusCode).toBe(201);
    let fund = (await events(A.buildingId)).filter((e) => e.kind === 'fund_statement_available');
    expect(fund).toHaveLength(1);
    expect(fund[0]!.evidence.contactId).toBe(A.owners.O1);
    expect(fund[0]!.evidence.ownerAccountId).toEqual(expect.any(String));

    // A second owner of the same building linking does not write a second event.
    await t.app.inject({ method: 'PATCH', url: `/api/contacts/${A.owners.O2}`, headers: { cookie: a.cookie }, payload: { email: 'bosko@firma-le.mk' } });
    const invite2 = (await post(`/api/contacts/${A.owners.O2}/portal-invite`)).json();
    const res2 = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code: invite2.code, email: 'bosko.owner@example.mk', password: 'correct-horse-1' } });
    expect(res2.statusCode).toBe(201);
    fund = (await events(A.buildingId)).filter((e) => e.kind === 'fund_statement_available');
    expect(fund).toHaveLength(1);
  });

  it('lists newest first and pages', async () => {
    const page = (await get(`/api/buildings/${A.buildingId}/legal-events?page=1&pageSize=2`)).json();
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBeGreaterThanOrEqual(5);
    const times = page.rows.map((r: EventRow) => Date.parse(r.occurredAt));
    expect(times[0]!).toBeGreaterThanOrEqual(times[1]!);
  });

  it('is invisible to another tenant and has no mutation route', async () => {
    expect((await get(`/api/buildings/${A.buildingId}/legal-events`, b.cookie)).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/buildings/${A.buildingId}/legal-events`, headers: { cookie: a.cookie } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/buildings/${A.buildingId}/legal-events`, headers: { cookie: a.cookie }, payload: {} })).statusCode).toBe(404);
  });
});
