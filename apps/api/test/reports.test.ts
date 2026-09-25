import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// One flag lets a single test take Chrome away and prove that nothing is filed when it is gone.
const h = vi.hoisted(() => ({ fail: false }));

vi.mock('playwright-core', () => {
  const launch = vi.fn(async () => ({
    isConnected: () => true,
    newContext: async () => ({
      newPage: async () => ({
        setContent: async () => {},
        pdf: async () => {
          if (h.fail) throw new Error('chrome is not installed');
          return Buffer.from('%PDF-report');
        },
      }),
      close: async () => {},
    }),
    close: async () => {},
  }));
  return { chromium: { launch } };
});

import { schema } from '@domar/db';
import { hashPassword } from '../src/auth/password.js';
import { fundBalance } from '../src/ledger.js';
import { setupReportBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

interface Fields { [k: string]: string | number }
interface FundSummary {
  fund: 'regular' | 'reserve';
  openingMinor: number; inflowMinor: number; outflowMinor: number;
  netInflowMinor: number; netOutflowMinor: number; closingMinor: number;
}
interface AnnualData {
  fields: Fields; funds: FundSummary[];
  expensesBySupplier: { supplier: string; count: number; amountMinor: number }[];
  works: { id: string; amountMinor: number }[];
  debtors: { contactId: string; balanceMinor: number }[];
  owners: { contactId: string; unitLabels: string[]; current: boolean; billedMinor: number; collectedMinor: number; balanceMinor: number }[];
}

describe('annual report (Art. 31)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let R: Awaited<ReturnType<typeof setupReportBuilding>>;
  let readonlyCookie = '';
  let billedMinor = 0;

  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const events = async () =>
    (await get(`/api/buildings/${R.buildingId}/legal-events?pageSize=100`)).json().rows as { kind: string; refId: string | null; evidence: Record<string, unknown> }[];
  const duty = async (key: string) =>
    (await get(`/api/buildings/${R.buildingId}/compliance`)).json().duties.find((d: { key: string }) => d.key === key) as { status: string; lastEvidenceAt: string | null };

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-report-a');
    b = await registerTenant(t.app, 'firma-report-b');
    R = await setupReportBuilding(t.app, a.cookie);
    billedMinor = R.invoices.O1.totalMinor + R.invoices.O2.totalMinor + R.invoices.O3.totalMinor;
    await t.db.insert(schema.users).values({
      tenantId: a.tenantId, email: 'ro@firma-report-a.mk', passwordHash: await hashPassword('correct-horse-1'),
      firstName: 'R', lastName: 'O', role: 'readonly',
    });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: 'firma-report-a', email: 'ro@firma-report-a.mk', password: 'correct-horse-1' } });
    readonlyCookie = String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async () => { h.fail = false; await t.close(); });

  it('previews the year straight out of the ledger', async () => {
    const res = await get(`/api/buildings/${R.buildingId}/reports/annual/preview?year=${R.year}`);
    expect(res.statusCode).toBe(200);
    const data = res.json() as AnnualData;

    expect(data.fields.year).toBe(R.year);
    expect(data.fields.unitCount).toBe(5);
    expect(data.fields.ownerCount).toBe(3);
    expect(data.fields.billedMinor).toBe(billedMinor);
    expect(data.fields.collectedMinor).toBe(R.invoices.O1.totalMinor);
    expect(data.fields.expensesMinor).toBe(170_000);
    expect(data.fields.worksCount).toBe(1);
    expect(data.fields.worksMinor).toBe(120_000);
    expect(data.works.map((w) => w.id)).toEqual([R.expenses.reserveId]);
    expect(data.fields.remindersSent).toBe(0);
    expect(data.fields.assembliesHeld).toBe(0);
    expect(data.fields.decisionsTaken).toBe(0);

    // The two owners who never paid, biggest debt first; O1 paid in full and is not a debtor.
    expect(data.fields.debtorsCount).toBe(2);
    expect(data.fields.totalDebtMinor).toBe(R.invoices.O2.totalMinor + R.invoices.O3.totalMinor);
    expect(data.debtors.map((d) => d.contactId)).not.toContain(R.owners.O1);
    expect(data.debtors[0]!.balanceMinor).toBeGreaterThanOrEqual(data.debtors[1]!.balanceMinor);
    expect(data.owners.find((o) => o.contactId === R.owners.O1)!.balanceMinor).toBe(0);
    expect(data.owners.find((o) => o.contactId === R.owners.O2)!.billedMinor).toBe(R.invoices.O2.totalMinor);

    expect(data.expensesBySupplier).toEqual([
      { supplier: 'Кровови ДООЕЛ', count: 1, amountMinor: 120_000 },
      { supplier: 'ЕВН Македонија', count: 1, amountMinor: 50_000 },
    ]);
  });

  it('balances both funds and accounts for every denar of cash', async () => {
    const data = (await get(`/api/buildings/${R.buildingId}/reports/annual/preview?year=${R.year}`)).json() as AnnualData;
    for (const f of data.funds) {
      expect(f.openingMinor + f.inflowMinor - f.outflowMinor, f.fund).toBe(f.closingMinor);
    }
    // The building has no history before this test run, so both funds open at zero and the closing
    // cash is exactly the reserve opening balance plus the one payment minus the two expenses.
    expect(data.funds.map((f) => [f.fund, f.openingMinor])).toEqual([['regular', 0], ['reserve', 0]]);
    const closing = data.funds.reduce((s, f) => s + f.closingMinor, 0);
    expect(closing).toBe(3_500_000 + R.invoices.O1.totalMinor - 170_000);
    expect(data.funds.find((f) => f.fund === 'reserve')!.outflowMinor).toBe(120_000);
    expect(data.funds.find((f) => f.fund === 'regular')!.outflowMinor).toBe(50_000);
  });

  it('refuses a year outside the supported range and hides a building of another tenant', async () => {
    expect((await get(`/api/buildings/${R.buildingId}/reports/annual/preview?year=1999`)).statusCode).toBe(400);
    expect((await get(`/api/buildings/${R.buildingId}/reports/annual/preview`)).statusCode).toBe(400);
    const cross = await get(`/api/buildings/${R.buildingId}/reports/annual/preview?year=${R.year}`, b.cookie);
    expect(cross.statusCode).toBe(404);
    expect(cross.json().error.code).toBe('not_found');
  });

  it('files the report as a portal-visible document, writes the event and turns Art. 31 green', async () => {
    expect((await duty('annual_report')).status).toBe('n/a');

    const res = await post(`/api/buildings/${R.buildingId}/reports/annual`, { year: R.year });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.document.kind).toBe('report');
    expect(body.document.mime).toBe('application/pdf');
    expect(body.document.title).toBe(`Годишен извештај ${R.year}`);
    expect(body.document.buildingId).toBe(R.buildingId);
    expect(body.document.storageKey).toBeUndefined(); // the storage layout never leaves the server
    expect(body.exportDocumentId).toBeNull();
    expect(body.year).toBe(R.year);
    expect(body.fields.billedMinor).toBe(billedMinor);

    const file = await get(`/api/documents/${body.document.id}/download`);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

    const issued = (await events()).filter((e) => e.kind === 'annual_report_issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]!.refId).toBe(body.document.id);
    expect(issued[0]!.evidence).toEqual({
      year: R.year,
      documentId: body.document.id,
      fundClosing: { regular: expect.any(Number), reserve: expect.any(Number) },
      debtorsCount: 2,
      totalDebtMinor: R.invoices.O2.totalMinor + R.invoices.O3.totalMinor,
    });

    const d = await duty('annual_report');
    expect(d.status).toBe('ok');
    expect(d.lastEvidenceAt).not.toBeNull();
  });

  it('issues a second version for the same year instead of overwriting the first', async () => {
    const again = await post(`/api/buildings/${R.buildingId}/reports/annual`, { year: R.year });
    expect(again.statusCode).toBe(201);

    const list = (await get(`/api/buildings/${R.buildingId}/reports`)).json();
    expect(list.rows).toHaveLength(2);
    expect(list.rows.every((r: { kind: string }) => r.kind === 'annual')).toBe(true);
    expect(list.rows[0]!.documentId).toBe(again.json().document.id);
    expect(list.rows[0]!.title).toBe(`Годишен извештај ${R.year}`);
    expect(list.rows[0]!.sizeBytes).toBeGreaterThan(0);
    expect(list.rows[0]!.exportDocumentId).toBeNull();
    expect(list.documents).toHaveLength(2);
    // The duty reads the newest event, so the second version is the one that counts.
    expect((await duty('annual_report')).status).toBe('ok');
  });

  it('shows the filed report to an owner in the portal', async () => {
    const code = (await post(`/api/contacts/${R.owners.O2}/portal-invite`)).json().code;
    const reg = await t.app.inject({
      method: 'POST', url: '/api/portal/register',
      payload: { code, email: 'o2@example.mk', password: 'correct-horse-1' },
    });
    expect(reg.statusCode).toBe(201);
    const portalCookie = String(reg.headers['set-cookie']).split(';')[0]!;
    const docs = await t.app.inject({
      method: 'GET', url: `/api/portal/documents?contactId=${R.owners.O2}&buildingId=${R.buildingId}`,
      headers: { cookie: portalCookie },
    });
    expect(docs.statusCode).toBe(200);
    const rows = docs.json().rows as { kind: string; title: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'report')).toBe(true);
    expect(rows[0]!.title).toBe(`Годишен извештај ${R.year}`);
  });

  it('lets readonly read a report and refuses to let it issue one', async () => {
    expect((await get(`/api/buildings/${R.buildingId}/reports`, readonlyCookie)).statusCode).toBe(200);
    expect((await get(`/api/buildings/${R.buildingId}/reports/annual/preview?year=${R.year}`, readonlyCookie)).statusCode).toBe(200);
    const res = await post(`/api/buildings/${R.buildingId}/reports/annual`, { year: R.year }, readonlyCookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('files nothing at all when the PDF renderer is unavailable', async () => {
    const before = (await get(`/api/buildings/${R.buildingId}/reports`)).json();
    h.fail = true;
    try {
      const res = await post(`/api/buildings/${R.buildingId}/reports/annual`, { year: R.year });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('pdf_unavailable');
    } finally {
      h.fail = false;
    }
    const after = (await get(`/api/buildings/${R.buildingId}/reports`)).json();
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.documents).toHaveLength(before.documents.length);
  });

  // Everything below moves the fixture's money, so it runs after the cases that read it untouched.

  it('reconciles with the ledger itself, before and after a void', async () => {
    const ctx = { tenantId: a.tenantId, userId: a.userId, role: 'owner' as const };
    const reconcile = async (): Promise<AnnualData> => {
      const d = (await get(`/api/buildings/${R.buildingId}/reports/annual/preview?year=${R.year}`)).json() as AnnualData;
      for (const f of d.funds) {
        expect(await fundBalance(t.db, ctx, R.buildingId, f.fund), f.fund).toBe(f.closingMinor);
        expect(f.openingMinor + f.inflowMinor - f.outflowMinor, `gross ${f.fund}`).toBe(f.closingMinor);
        expect(f.openingMinor + f.netInflowMinor - f.netOutflowMinor, `net ${f.fund}`).toBe(f.closingMinor);
        expect(f.netInflowMinor, `net in ${f.fund}`).toBeGreaterThanOrEqual(0);
        expect(f.netOutflowMinor, `net out ${f.fund}`).toBeGreaterThanOrEqual(0);
      }
      // The reserve fund screen and the report read the same cash.
      expect((await get(`/api/buildings/${R.buildingId}/reserve-fund`)).json().balanceMinor)
        .toBe(d.funds.find((f) => f.fund === 'reserve')!.closingMinor);
      for (const o of d.owners) {
        const statement = (await get(`/api/contacts/${o.contactId}/statement?buildingId=${R.buildingId}`)).json();
        expect(statement.balanceMinor, o.contactId).toBe(o.balanceMinor);
      }
      return d;
    };

    await reconcile();
    expect((await post(`/api/buildings/${R.buildingId}/reserve-fund/expenses/${R.expenses.regularId}/void`, { reason: 'погрешен износ' })).statusCode).toBe(200);
    expect((await post(`/api/payments/${R.paymentId}/void`, { reason: 'вратена уплата' })).statusCode).toBe(200);
    const after = await reconcile();

    // The void is not spending and the voided payment is not income, on either side of the ledger.
    expect(after.fields.expensesMinor).toBe(120_000);
    expect(after.fields.collectedMinor).toBe(0);
    expect(after.fields.billedMinor).toBe(billedMinor);
    expect(after.fields.debtorsCount).toBe(3);
    expect(after.owners.find((o) => o.contactId === R.owners.O1)!.balanceMinor).toBe(R.invoices.O1.totalMinor);
    expect(after.funds.find((f) => f.fund === 'regular')).toMatchObject({ netInflowMinor: 0, netOutflowMinor: 0, closingMinor: 0 });
    expect(after.funds.find((f) => f.fund === 'reserve')!.netOutflowMinor).toBe(120_000);
  });

  it('leaves an expense in the year it was paid when the void comes a year later', async () => {
    const id = (await post(`/api/buildings/${R.buildingId}/reserve-fund/expenses`, {
      fund: 'regular', description: 'Ланска поправка', supplierText: 'Мајстор', amountMinor: 90_000,
      paidAt: `${R.year - 1}-06-15T10:00:00.000Z`,
    })).json().id;
    expect((await post(`/api/buildings/${R.buildingId}/reserve-fund/expenses/${id}/void`, { reason: 'двојно внесен' })).statusCode).toBe(200);

    // Last year's report is the one already handed to the owners: the money was spent that year.
    const prev = (await get(`/api/buildings/${R.buildingId}/reports/annual/preview?year=${R.year - 1}`)).json() as AnnualData;
    expect(prev.fields.expensesMinor).toBe(90_000);
    expect(prev.works).toHaveLength(0);

    // This year books only the reversal, and it offsets nothing this year did not itself spend.
    const ctx = { tenantId: a.tenantId, userId: a.userId, role: 'owner' as const };
    const cur = (await get(`/api/buildings/${R.buildingId}/reports/annual/preview?year=${R.year}`)).json() as AnnualData;
    expect(cur.fields.expensesMinor).toBe(120_000);
    for (const f of cur.funds) {
      expect(f.netInflowMinor, `net in ${f.fund}`).toBeGreaterThanOrEqual(0);
      expect(f.netOutflowMinor, `net out ${f.fund}`).toBeGreaterThanOrEqual(0);
      expect(f.openingMinor + f.netInflowMinor - f.netOutflowMinor, `net ${f.fund}`).toBe(f.closingMinor);
      expect(await fundBalance(t.db, ctx, R.buildingId, f.fund), f.fund).toBe(f.closingMinor);
    }
    expect(cur.funds.find((f) => f.fund === 'regular')!.netOutflowMinor).toBe(0);
  });

  it('keeps an owner who sold during the year, with no units and their debt intact', async () => {
    const buyer = (await post('/api/contacts', { firstName: 'Нов', lastName: 'Купувач' })).json().id;
    const units = (await get(`/api/buildings/${R.buildingId}/units`)).json().rows as { id: string; ownerContactId: string | null }[];
    const sold = units.find((u) => u.ownerContactId === R.owners.O2)!;
    const patch = await t.app.inject({
      method: 'PATCH', url: `/api/buildings/${R.buildingId}/units/${sold.id}`,
      headers: { cookie: a.cookie }, payload: { ownerContactId: buyer },
    });
    expect(patch.statusCode).toBe(200);

    const d = (await get(`/api/buildings/${R.buildingId}/reports/annual/preview?year=${R.year}`)).json() as AnnualData;
    expect(d.fields.ownerCount).toBe(4);
    const former = d.owners.find((o) => o.contactId === R.owners.O2)!;
    expect(former).toMatchObject({ current: false, unitLabels: [] });
    expect(former.billedMinor).toBe(R.invoices.O2.totalMinor);
    expect(former.balanceMinor).toBe(R.invoices.O2.totalMinor);
    expect(d.owners.find((o) => o.contactId === buyer)).toMatchObject({ current: true, billedMinor: 0, balanceMinor: 0 });
    // The debt did not leave the building with the seller.
    expect(d.debtors.map((x) => x.contactId)).toContain(R.owners.O2);
    expect(d.fields.totalDebtMinor).toBe(billedMinor);
  });

  it('never reports a negative collection when a prior-year payment is voided in this one', async () => {
    // One real collection this year, so the figure under test is a number and not merely a zero.
    const collected = 40_000;
    expect((await post(`/api/invoices/${R.invoices.O3.id}/payments`, {
      amountMinor: collected, method: 'cash', paidAt: new Date().toISOString(),
    })).statusCode).toBe(201);

    // Two payments of last year. Their originals are booked in last year's window and their voids in
    // this one, which is exactly the shape that used to drive this year's collections below zero.
    const lastYear = `${R.year - 1}-06-15T10:00:00.000Z`;
    const ids: string[] = [];
    for (const [key, amountMinor] of [['O1', 150_000], ['O2', 200_000]] as const) {
      ids.push((await post(`/api/invoices/${R.invoices[key].id}/payments`, { amountMinor, method: 'bank_transfer', paidAt: lastYear })).json().payment.id);
    }
    for (const id of ids) expect((await post(`/api/payments/${id}/void`, { reason: 'вратена уплата' })).statusCode).toBe(200);

    // Last year collected the two payments and is the report already handed to the owners; the void
    // belongs to the year that booked it and takes nothing out of last year's figure.
    const prev = (await get(`/api/buildings/${R.buildingId}/reports/annual/preview?year=${R.year - 1}`)).json() as AnnualData;
    expect(prev.fields.collectedMinor).toBe(350_000);
    expect(prev.owners.find((o) => o.contactId === R.owners.O2)!.collectedMinor).toBe(200_000);

    // This year collected 400,00 den and nothing else: the two voids reverse money it never took in.
    const cur = (await get(`/api/buildings/${R.buildingId}/reports/annual/preview?year=${R.year}`)).json() as AnnualData;
    expect(cur.fields.collectedMinor).toBe(collected);
    expect(cur.fields.collectionRateBp).toBe(Math.round((collected * 10_000) / billedMinor));
    expect(cur.fields.collectionRateBp).toBeGreaterThan(0);
    for (const o of cur.owners) {
      expect(o.collectedMinor, o.contactId).toBeGreaterThanOrEqual(0);
    }
    expect(cur.owners.find((o) => o.contactId === R.owners.O3)!.collectedMinor).toBe(collected);
    expect(cur.owners.find((o) => o.contactId === R.owners.O1)!.collectedMinor).toBe(0);
    expect(cur.owners.find((o) => o.contactId === R.owners.O2)!.collectedMinor).toBe(0);
  });

  it('leaves out a contact whose only posting predates the window, and keeps a silent current owner', async () => {
    // Somebody the ledger touched only last year: their money is in last year's report, not this one.
    const gone = (await post('/api/contacts', { firstName: 'Стар', lastName: 'Сопственик' })).json().id;
    expect((await post(`/api/buildings/${R.buildingId}/payments`, {
      contactId: gone, amountMinor: 10_000, method: 'cash', paidAt: `${R.year - 1}-03-10T10:00:00.000Z`,
    })).statusCode).toBe(201);
    // Somebody who owns a unit today and whom the ledger has never named at all.
    const silent = (await post('/api/contacts', { firstName: 'Тивок', lastName: 'Сопственик' })).json().id;
    expect((await post(`/api/buildings/${R.buildingId}/units`, { label: 'S-2', kind: 'storage', areaM2: 8, ownerContactId: silent })).statusCode).toBe(201);

    const cur = (await get(`/api/buildings/${R.buildingId}/reports/annual/preview?year=${R.year}`)).json() as AnnualData;
    expect(cur.owners.map((o) => o.contactId)).not.toContain(gone);
    expect(cur.owners.find((o) => o.contactId === silent)).toMatchObject({ current: true, billedMinor: 0, collectedMinor: 0, balanceMinor: 0 });
    expect(cur.fields.ownerCount).toBe(cur.owners.length);

    // Last year's report is where that contact belongs, and there they are.
    const prev = (await get(`/api/buildings/${R.buildingId}/reports/annual/preview?year=${R.year - 1}`)).json() as AnnualData;
    expect(prev.owners.map((o) => o.contactId)).toContain(gone);
  });

  it('refuses a year that has not begun in the tenant zone', async () => {
    const next = R.year + 1;
    const preview = await get(`/api/buildings/${R.buildingId}/reports/annual/preview?year=${next}`);
    expect(preview.statusCode).toBe(400);
    expect(preview.json().error.code).toBe('year_in_the_future');
    const issued = await post(`/api/buildings/${R.buildingId}/reports/annual`, { year: next });
    expect(issued.statusCode).toBe(400);
    expect(issued.json().error.code).toBe('year_in_the_future');
    expect((await get(`/api/buildings/${R.buildingId}/reports`)).json().rows).toHaveLength(2);
  });
});
