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
import { setupReportBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

interface Fields { [k: string]: string | number }
interface FundSummary { fund: string; openingMinor: number; inflowMinor: number; outflowMinor: number; closingMinor: number }
interface AnnualData {
  fields: Fields; funds: FundSummary[];
  expensesBySupplier: { supplier: string; count: number; amountMinor: number }[];
  works: { id: string; amountMinor: number }[];
  debtors: { contactId: string; balanceMinor: number }[];
  owners: { contactId: string; billedMinor: number; collectedMinor: number; balanceMinor: number }[];
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
});
