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

import { strFromU8, unzipSync } from 'fflate';
import { setupReportBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

/** The tenant's civil day, which is what `asOf` is measured in. */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

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
    // One document exists before the handover, so the export's index has exactly one row to carry.
    annualDocumentId = (await post(`/api/buildings/${R.buildingId}/reports/annual`, { year: R.year })).json().document.id;
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
    // O2 and O3 never paid; O1's invoice is settled and is not an open item.
    expect(data.openItems).toHaveLength(2);
    expect(data.fields.openItemsMinor).toBe(R.invoices.O2.totalMinor + R.invoices.O3.totalMinor);
    expect(data.fields.openItemsMinor).toBe(data.fields.totalDebtMinor);
    expect(data.openItems[0]!.outstandingMinor).toBeGreaterThanOrEqual(data.openItems[1]!.outstandingMinor);
    // With no bank balances given, the report reads as reconciled rather than as a fake shortfall.
    expect(data.reconciliation.map((r) => r.differenceMinor)).toEqual([0, 0]);
    expect(data.reconciliation.map((r) => r.fund)).toEqual(['regular', 'reserve']);
  });

  it('refuses a handover dated after today', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const res = await get(`/api/buildings/${R.buildingId}/reports/handover/preview?asOf=${tomorrow}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('as_of_in_the_future');
    expect((await get(`/api/buildings/${R.buildingId}/reports/handover/preview?asOf=${asOf}`, b.cookie)).statusCode).toBe(404);
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
      bankBalances: { regularMinor: ledgerRegular + 12_345, reserveMinor: ledgerReserve },
    });

    expect((await duty('handover')).status).toBe('ok');

    const list = (await get(`/api/buildings/${R.buildingId}/reports`)).json();
    expect(list.rows.map((r: { kind: string }) => r.kind)).toEqual(['handover', 'annual']);
    expect(list.rows[0]!.exportDocumentId).toBe(body.exportDocumentId);
  });

  it('exports seven CSV files with the building in them', async () => {
    const list = (await get(`/api/buildings/${R.buildingId}/reports`)).json();
    const exportId = list.rows[0]!.exportDocumentId as string;
    const file = await get(`/api/documents/${exportId}/download`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/zip');
    expect(file.rawPayload.subarray(0, 2).toString()).toBe('PK');

    const entries = unzipSync(new Uint8Array(file.rawPayload));
    expect(Object.keys(entries).sort()).toEqual([
      'dokumenti.csv', 'edinici.csv', 'presmetki.csv', 'salda.csv', 'sopstvenici.csv', 'troshoci.csv', 'uplati.csv',
    ]);

    /**
     * Header line plus data lines; every file is written with a BOM and `;` separators. The BOM is
     * checked on the bytes: `strFromU8` decodes through `TextDecoder`, which swallows a leading one.
     */
    const read = (name: string) => {
      const bytes = entries[name]!;
      expect([...bytes.subarray(0, 3)], name).toEqual([0xef, 0xbb, 0xbf]);
      const lines = strFromU8(bytes.subarray(3)).trimEnd().split('\n');
      return { header: lines[0]!, rows: lines.slice(1) };
    };

    const units = read('edinici.csv');
    expect(units.header).toBe('број;кат;тип;површина;удел;сопственик;е-пошта');
    expect(units.rows).toHaveLength(5);

    const owners = read('sopstvenici.csv');
    expect(owners.header).toBe('име;презиме;е-пошта;телефон;адреса;единици');
    expect(owners.rows).toHaveLength(3);

    const balances = read('salda.csv');
    expect(balances.header).toBe('сопственик;единици;фактурирано;наплатено;салдо');
    expect(balances.rows).toHaveLength(3);
    // The statement of an owner who paid nothing is their whole invoice, to the denar.
    const o2 = balances.rows.find((r) => r.includes('Бошковски'))!;
    expect(o2.endsWith(`;${(R.invoices.O2.totalMinor / 100).toFixed(2).replace('.', ',')}`)).toBe(true);

    expect(read('presmetki.csv').header).toBe('број;период;сопственик;издадена;рок;вкупно;платено;неплатено;статус');
    expect(read('presmetki.csv').rows).toHaveLength(3);
    expect(read('uplati.csv').header).toBe('датум;сопственик;фактура;износ;начин;референца;статус');
    expect(read('uplati.csv').rows).toHaveLength(1);
    expect(read('troshoci.csv').header).toBe('датум;фонд;опис;добавувач;износ');
    expect(read('troshoci.csv').rows).toHaveLength(2);

    // The index is the documentation as it stood at the handover: the annual report, and not the two
    // documents this very call filed (plan addendum 11).
    const documents = read('dokumenti.csv');
    expect(documents.header).toBe('наслов;тип;датотека;мим-тип;големина;создаден;sha256');
    expect(documents.rows).toHaveLength(1);
    expect(documents.rows[0]).toContain(`Годишен извештај ${R.year}`);
    expect(annualDocumentId).not.toBe('');
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
