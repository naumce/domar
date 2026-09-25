import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('playwright-core', () => {
  const launch = vi.fn(async () => ({
    isConnected: () => true,
    newContext: async () => ({
      newPage: async () => ({ setContent: async () => {}, pdf: async () => Buffer.from('%PDF-handover') }),
      close: async () => {},
    }),
    close: async () => {},
  }));
  return { chromium: { launch } };
});

import { schema } from '@domar/db';
import { parseUnitImport } from '@domar/domain';
import { and, eq } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import { hashPassword } from '../src/auth/password.js';
import { handoverReport } from '../src/resources/reports/data.js';
import { buildHandoverExport } from '../src/resources/reports/export.js';
import { setupReportBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const ZONE = 'Europe/Skopje';
/** The tenant's civil day, which is what `asOf` is measured in. */
const civilDay = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const today = () => civilDay(new Date());
/** Minor units the way a `;` file prints them. */
const money = (minor: number) => (minor / 100).toFixed(2).replace('.', ',');

/**
 * Header line plus data lines; every file is written with a BOM and `;` separators. The BOM is
 * checked on the bytes: `strFromU8` decodes through `TextDecoder`, which swallows a leading one.
 */
const readCsv = (entries: Record<string, Uint8Array>, name: string) => {
  const bytes = entries[name]!;
  expect([...bytes.subarray(0, 3)], name).toEqual([0xef, 0xbb, 0xbf]);
  const lines = strFromU8(bytes.subarray(3)).trimEnd().split('\n');
  return { header: lines[0]!, rows: lines.slice(1) };
};

interface Reconciliation { fund: string; ledgerMinor: number; bankMinor: number; differenceMinor: number }
interface HandoverData {
  fields: Record<string, string | number>;
  openItems: { invoiceId: string; outstandingMinor: number }[];
  owners: { contactId: string }[];
  reconciliation: Reconciliation[];
}

describe('handover report and data export (Art. 30)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let R: Awaited<ReturnType<typeof setupReportBuilding>>;
  let asOf = '';
  let annualDocumentId = '';
  let readonlyCookie = '';
  let handoverDocumentId = '';
  let handoverExportId = '';

  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const duty = async (key: string) =>
    (await get(`/api/buildings/${R.buildingId}/compliance`)).json().duties.find((d: { key: string }) => d.key === key) as { status: string; dueAt: string | null };

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-handover-a');
    b = await registerTenant(t.app, 'firma-handover-b');
    R = await setupReportBuilding(t.app, a.cookie);
    asOf = today();
    // The management contract that ends today is what starts the Art. 30 clock (spec §4).
    const contract = await post(`/api/buildings/${R.buildingId}/contracts`, {
      kind: 'management', title: 'Договор за управување', startsOn: `${R.year}-01-01`, endsOn: asOf,
    });
    expect(contract.statusCode).toBe(201);
    // A reversed expense and a reversed payment: both stay in the archive, flagged, because the next
    // manager has to see that the money left and came back. Neither changes a fund or a balance.
    const voidedExpense = (await post(`/api/buildings/${R.buildingId}/reserve-fund/expenses`, {
      fund: 'regular', description: 'Погрешно внесен трошок', supplierText: 'ЕВН Македонија',
      amountMinor: 33_300, paidAt: new Date().toISOString(),
    })).json().id;
    expect((await post(`/api/buildings/${R.buildingId}/reserve-fund/expenses/${voidedExpense}/void`, { reason: 'погрешен износ' })).statusCode).toBe(200);
    const voidedPayment = (await post(`/api/invoices/${R.invoices.O2.id}/payments`, {
      amountMinor: R.invoices.O2.totalMinor, method: 'cash', reference: 'ПЛ-2', paidAt: new Date().toISOString(),
    })).json().payment.id;
    expect((await post(`/api/payments/${voidedPayment}/void`, { reason: 'вратена уплата' })).statusCode).toBe(200);
    // One document exists before the handover, so the export's index has exactly one row to carry.
    annualDocumentId = (await post(`/api/buildings/${R.buildingId}/reports/annual`, { year: R.year })).json().document.id;
    await t.db.insert(schema.users).values({
      tenantId: a.tenantId, email: 'ro@firma-handover-a.mk', passwordHash: await hashPassword('correct-horse-1'),
      firstName: 'R', lastName: 'O', role: 'readonly',
    });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: 'firma-handover-a', email: 'ro@firma-handover-a.mk', password: 'correct-horse-1' } });
    readonlyCookie = String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async () => { await t.close(); });

  it('previews the handover with the bank defaulting to the ledger', async () => {
    const res = await get(`/api/buildings/${R.buildingId}/reports/handover/preview?asOf=${asOf}`);
    expect(res.statusCode).toBe(200);
    const data = res.json() as HandoverData;

    expect(data.fields.asOf).toBe(asOf);
    expect(data.fields.contractEndsOn).toBe(asOf);
    expect(data.fields.note).toBe('');
    expect(data.owners).toHaveLength(3);
    // O2's only payment was reversed and O3 never paid; O1's invoice is settled and is not an open item.
    expect(data.openItems).toHaveLength(2);
    expect(data.fields.openItemsMinor).toBe(R.invoices.O2.totalMinor + R.invoices.O3.totalMinor);
    expect(data.fields.openItemsMinor).toBe(data.fields.totalDebtMinor);
    expect(data.openItems[0]!.outstandingMinor).toBeGreaterThanOrEqual(data.openItems[1]!.outstandingMinor);
    // With no bank balances given, the report reads as reconciled rather than as a fake shortfall.
    expect(data.reconciliation.map((r) => r.differenceMinor)).toEqual([0, 0]);
    expect(data.reconciliation.map((r) => r.fund)).toEqual(['regular', 'reserve']);
  });

  it('refuses a handover dated after today', async () => {
    // Two days on, read in the tenant's zone: a UTC date would be *today* in Skopje late in the evening.
    const tomorrow = civilDay(new Date(Date.now() + 2 * 86_400_000));
    const res = await get(`/api/buildings/${R.buildingId}/reports/handover/preview?asOf=${tomorrow}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('as_of_in_the_future');
    expect((await get(`/api/buildings/${R.buildingId}/reports/handover/preview?asOf=${asOf}`, b.cookie)).statusCode).toBe(404);
  });

  it('refuses a date that is not a calendar day and a bank balance past the bound', async () => {
    expect((await get(`/api/buildings/${R.buildingId}/reports/handover/preview?asOf=2026-02-31`)).statusCode).toBe(400);
    expect((await post(`/api/buildings/${R.buildingId}/reports/handover`, { asOf: '2026-02-31', bankBalances: { regularMinor: 0, reserveMinor: 0 } })).statusCode).toBe(400);
    // The preview's bank query is bounded exactly like the body it stands in for.
    expect((await get(`/api/buildings/${R.buildingId}/reports/handover/preview?asOf=${asOf}&regularMinor=1000000000001&reserveMinor=0`)).statusCode).toBe(400);
    expect((await get(`/api/buildings/${R.buildingId}/reports/handover/preview?asOf=${asOf}&regularMinor=100`)).statusCode).toBe(400);
  });

  it('files the report and the export, names the bank difference and stops the 8-day clock', async () => {
    const d = await duty('handover');
    expect(d.status).toBe('due'); // the contract ended today and nothing has been handed over yet
    expect(d.dueAt).not.toBeNull();

    const preview = (await get(`/api/buildings/${R.buildingId}/reports/handover/preview?asOf=${asOf}`)).json() as HandoverData;
    const ledgerRegular = preview.reconciliation[0]!.ledgerMinor;
    const ledgerReserve = preview.reconciliation[1]!.ledgerMinor;

    const res = await post(`/api/buildings/${R.buildingId}/reports/handover`, {
      asOf,
      // 123,45 den more on the statement than in the ledger: the report names it, nobody corrects it.
      bankBalances: { regularMinor: ledgerRegular + 12_345, reserveMinor: ledgerReserve },
      note: 'Предадено на новиот управител.',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    handoverDocumentId = body.document.id;
    handoverExportId = body.exportDocumentId;
    expect(body.document.kind).toBe('report');
    expect(body.document.title).toBe(`Извештај за примопредавање ${asOf}`);
    expect(body.exportDocumentId).not.toBeNull();
    expect(body.fields.regularDifferenceMinor).toBe(12_345);
    expect(body.fields.reserveDifferenceMinor).toBe(0);
    expect(body.fields.note).toBe('Предадено на новиот управител.');

    const zipDoc = (await get(`/api/documents/${body.exportDocumentId}`)).json();
    expect(zipDoc.kind).toBe('other');
    expect(zipDoc.mime).toBe('application/zip');
    expect(zipDoc.fileName).toBe(`primopredavanje-${asOf}-${R.buildingId}.zip`);

    const events = (await get(`/api/buildings/${R.buildingId}/legal-events?pageSize=100`)).json().rows as { kind: string; refId: string | null; evidence: Record<string, unknown> }[];
    const issued = events.filter((e) => e.kind === 'handover_report_issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]!.refId).toBe(body.document.id);
    expect(issued[0]!.evidence).toEqual({
      asOf,
      contractEndsOn: asOf,
      documentId: body.document.id,
      exportDocumentId: body.exportDocumentId,
      ownersCount: 3,
      totalDebtMinor: R.invoices.O2.totalMinor + R.invoices.O3.totalMinor,
      // The two ledger closings and the two bank readings: the printed difference is arithmetic on
      // the event itself, years later, with nothing to re-derive from the ledger.
      fundClosing: { regular: ledgerRegular, reserve: ledgerReserve },
      bankBalances: { regularMinor: ledgerRegular + 12_345, reserveMinor: ledgerReserve },
    });

    expect((await duty('handover')).status).toBe('ok');

    const list = (await get(`/api/buildings/${R.buildingId}/reports`)).json();
    expect(list.rows.map((r: { kind: string }) => r.kind)).toEqual(['handover', 'annual']);
    expect(list.rows[0]!.exportDocumentId).toBe(body.exportDocumentId);
  });

  it('exports seven CSV files with the building in them', async () => {
    const file = await get(`/api/documents/${handoverExportId}/download`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/zip');
    expect(file.rawPayload.subarray(0, 2).toString()).toBe('PK');

    const entries = unzipSync(new Uint8Array(file.rawPayload));
    expect(Object.keys(entries).sort()).toEqual([
      'dokumenti.csv', 'edinici.csv', 'presmetki.csv', 'salda.csv', 'sopstvenici.csv', 'troshoci.csv', 'uplati.csv',
    ]);
    const read = (name: string) => readCsv(entries, name);

    const units = read('edinici.csv');
    expect(units.header).toBe('број;кат;тип;површина;удел;име;презиме;е-пошта;телефон');
    expect(units.rows).toHaveLength(5);
    // The archive is the file the next manager feeds straight back into the units import.
    const reimported = parseUnitImport(strFromU8(entries['edinici.csv']!));
    expect(reimported.errors).toEqual([]);
    expect(reimported.rows.map((r) => r.label).sort()).toEqual(['1', '2', 'L1', 'P-1', 'S-1']);
    expect(reimported.rows.find((r) => r.label === '2')).toMatchObject({ kind: 'apartment', areaM2: 75, ownerLastName: 'Бошковски' });

    const owners = read('sopstvenici.csv');
    expect(owners.header).toBe('име;презиме;е-пошта;телефон;адреса;единици');
    expect(owners.rows).toHaveLength(3);

    const balances = read('salda.csv');
    expect(balances.header).toBe('сопственик;единици;фактурирано;наплатено;салдо');
    expect(balances.rows).toHaveLength(3);
    // The statement of an owner whose only payment was reversed is their whole invoice, to the denar.
    const o2 = balances.rows.find((r) => r.includes('Бошковски'))!;
    expect(o2.endsWith(`;${money(R.invoices.O2.totalMinor)}`)).toBe(true);

    const invoices = read('presmetki.csv');
    expect(invoices.header).toBe('број;период;сопственик;издадена;рок;вкупно;платено;неплатено;статус');
    expect(invoices.rows).toHaveLength(3);
    // O2's reversed payment never counted: the invoice is unpaid on the handover day.
    const o2Invoice = invoices.rows.find((r) => r.startsWith(`${R.invoices.O2.number};`))!;
    expect(o2Invoice.endsWith(`;${money(R.invoices.O2.totalMinor)};0,00;${money(R.invoices.O2.totalMinor)};published`)).toBe(true);

    const payments = read('uplati.csv');
    expect(payments.header).toBe('датум;сопственик;фактура;износ;начин;референца;статус');
    expect(payments.rows).toHaveLength(2);
    expect(payments.rows.filter((r) => r.endsWith(';completed'))).toHaveLength(1);
    expect(payments.rows.filter((r) => r.endsWith(';voided'))).toHaveLength(1);

    const expenses = read('troshoci.csv');
    expect(expenses.header).toBe('датум;фонд;опис;добавувач;износ;статус');
    expect(expenses.rows).toHaveLength(3);
    expect(expenses.rows.filter((r) => r.endsWith(';активна'))).toHaveLength(2);
    const reversed = expenses.rows.filter((r) => r.endsWith(';сторнирана'));
    expect(reversed).toHaveLength(1);
    expect(reversed[0]).toContain('Погрешно внесен трошок');
    // Every date is the tenant's civil day, not a UTC one.
    expect(expenses.rows.every((r) => r.startsWith(`${asOf};`))).toBe(true);

    // The index is the documentation as it stood at the handover: the annual report, and not the two
    // documents this very call filed (plan addendum 11).
    const documents = read('dokumenti.csv');
    expect(documents.header).toBe('наслов;тип;датотека;мим-тип;големина;создаден;sha256');
    expect(documents.rows).toHaveLength(1);
    expect(documents.rows[0]).toContain(`Годишен извештај ${R.year}`);
    expect(annualDocumentId).not.toBe('');
  });

  it('pages through every invoice and payment instead of stopping at the first page', async () => {
    const ctx = { tenantId: a.tenantId, userId: a.userId, role: 'owner' as const };
    const { to, data } = await handoverReport(t.db, ctx, R.buildingId, { asOf });
    // A page of one: the building has three invoices and two payments, so anything that reads a
    // single page hands over a third of the billing and half of the money.
    const entries = unzipSync(new Uint8Array(await buildHandoverExport(t.db, ctx, R.buildingId, data, { to, timeZone: ZONE, pageSize: 1 })));
    expect(readCsv(entries, 'presmetki.csv').rows).toHaveLength(3);
    expect(readCsv(entries, 'uplati.csv').rows).toHaveLength(2);
  });

  it('lets readonly preview a handover and refuses to let it file one', async () => {
    expect((await get(`/api/buildings/${R.buildingId}/reports/handover/preview?asOf=${asOf}`, readonlyCookie)).statusCode).toBe(200);
    const res = await post(`/api/buildings/${R.buildingId}/reports/handover`, {
      asOf, bankBalances: { regularMinor: 0, reserveMinor: 0 },
    }, readonlyCookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('shows an owner the report in the portal and never the data export', async () => {
    const code = (await post(`/api/contacts/${R.owners.O1}/portal-invite`)).json().code;
    const reg = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code, email: 'o1@handover.mk', password: 'correct-horse-1' } });
    expect(reg.statusCode).toBe(201);
    const cookie = String(reg.headers['set-cookie']).split(';')[0]!;
    const portalGet = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie } });

    const rows = (await portalGet(`/api/portal/documents?contactId=${R.owners.O1}&buildingId=${R.buildingId}`)).json().rows as { id: string; mime: string }[];
    expect(rows.map((d) => d.id)).toContain(handoverDocumentId);
    expect(rows.map((d) => d.id)).not.toContain(handoverExportId);
    expect(rows.map((d) => d.mime)).not.toContain('application/zip');
    expect((await portalGet(`/api/portal/documents/${handoverDocumentId}/download?contactId=${R.owners.O1}`)).statusCode).toBe(200);
    expect((await portalGet(`/api/portal/documents/${handoverExportId}/download?contactId=${R.owners.O1}`)).statusCode).toBe(404);
  });

  it('reads the money as of the handover day and not as of today', async () => {
    const plain = await setupReportBuilding(t.app, a.cookie);
    const yesterday = civilDay(new Date(Date.now() - 86_400_000));
    // The fixture bills at publish time, i.e. now; backdating the invoices gives a handover dated
    // yesterday something that was already issued when it was signed.
    await t.db.update(schema.invoices).set({ issuedAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(and(eq(schema.invoices.tenantId, a.tenantId), eq(schema.invoices.buildingId, plain.buildingId)));
    // Paid today, which is after the handover: on the day the report covers it was still owed.
    expect((await post(`/api/invoices/${plain.invoices.O2.id}/payments`, {
      amountMinor: plain.invoices.O2.totalMinor, method: 'cash', paidAt: new Date().toISOString(),
    })).statusCode).toBe(201);

    const back = (await get(`/api/buildings/${plain.buildingId}/reports/handover/preview?asOf=${yesterday}`)).json() as HandoverData;
    const item = back.openItems.find((i) => i.invoiceId === plain.invoices.O2.id);
    expect(item!.outstandingMinor).toBe(plain.invoices.O2.totalMinor);
    // The same invoice read today: settled by the live status, and no longer an open item.
    const now = (await get(`/api/buildings/${plain.buildingId}/reports/handover/preview?asOf=${asOf}`)).json() as HandoverData;
    expect(now.openItems.map((i) => i.invoiceId)).not.toContain(plain.invoices.O2.id);

    const res = await post(`/api/buildings/${plain.buildingId}/reports/handover`, {
      asOf: yesterday, bankBalances: { regularMinor: 0, reserveMinor: 0 },
    });
    expect(res.statusCode).toBe(201);
    const file = await get(`/api/documents/${res.json().exportDocumentId}/download`);
    const entries = unzipSync(new Uint8Array(file.rawPayload));
    const invoices = readCsv(entries, 'presmetki.csv');
    expect(invoices.rows).toHaveLength(3);
    const line = invoices.rows.find((r) => r.startsWith(`${plain.invoices.O2.number};`))!;
    expect(line.endsWith(`;${money(plain.invoices.O2.totalMinor)};0,00;${money(plain.invoices.O2.totalMinor)};published`)).toBe(true);
    // Today's payment and today's expenses are the next manager's business, not this archive's.
    expect(readCsv(entries, 'uplati.csv').rows).toHaveLength(0);
    expect(readCsv(entries, 'troshoci.csv').rows).toHaveLength(0);
  });

  it('hands over a building with no management contract on file and leaves Art. 30 as n/a', async () => {
    const plain = await setupReportBuilding(t.app, a.cookie);
    const res = await post(`/api/buildings/${plain.buildingId}/reports/handover`, {
      asOf, bankBalances: { regularMinor: 0, reserveMinor: 0 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().fields.contractEndsOn).toBe('');
    const d = (await get(`/api/buildings/${plain.buildingId}/compliance`)).json().duties.find((x: { key: string }) => x.key === 'handover');
    expect(d.status).toBe('n/a');
  });
});
