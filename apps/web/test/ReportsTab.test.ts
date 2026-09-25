import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnnualReportData, ReportRow } from '@/api/types';
import ReportsTab from '@/components/building/ReportsTab.vue';
import { i18n } from '@/i18n';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const YEAR = new Date().getFullYear();

const preview: AnnualReportData = {
  fields: {
    year: YEAR, periodFrom: `${YEAR - 1}-12-31T23:00:00.000Z`, periodTo: `${YEAR}-12-31T23:00:00.000Z`,
    buildingName: 'Партизанска 12', buildingAddress: 'Партизанска 12, 1000 Скопје',
    managerName: 'Домар ДООЕЛ', managerCompanyNumber: '7654321', unitCount: 4, ownerCount: 3,
    regularOpeningMinor: 100_000, regularInflowMinor: 300_000, regularOutflowMinor: 150_000, regularClosingMinor: 250_000,
    reserveOpeningMinor: 800_000, reserveInflowMinor: 60_000, reserveOutflowMinor: 600_000, reserveClosingMinor: 260_000,
    billedMinor: 600_000, collectedMinor: 360_000, expensesMinor: 750_000, collectionRateBp: 6000,
    debtorsCount: 2, totalDebtMinor: 240_000,
    remindersSent: 4, assembliesHeld: 1, decisionsTaken: 2, worksCount: 2, worksMinor: 600_000,
  },
  funds: [
    { fund: 'regular', openingMinor: 100_000, inflowMinor: 300_000, outflowMinor: 150_000, netInflowMinor: 300_000, netOutflowMinor: 150_000, closingMinor: 250_000, movements: [] },
    { fund: 'reserve', openingMinor: 800_000, inflowMinor: 60_000, outflowMinor: 600_000, netInflowMinor: 60_000, netOutflowMinor: 600_000, closingMinor: 260_000, movements: [] },
  ],
  expenses: [],
  expensesBySupplier: [{ supplier: 'Кровови ДООЕЛ', count: 2, amountMinor: 600_000 }],
  works: [],
  owners: [],
  debtors: [{ contactId: 'c-3', name: 'Вера Велкова', unitLabels: ['3'], balanceMinor: 180_000 }],
  assemblies: [],
};

const annualRow: ReportRow = {
  eventId: 'e-1', kind: 'annual', occurredAt: `${YEAR}-09-25T09:00:00.000Z`,
  documentId: 'doc-annual', exportDocumentId: null,
  title: `Годишен извештај ${YEAR}`, fileName: 'godisen.pdf', sizeBytes: 2048, evidence: {},
};
const handoverRow: ReportRow = {
  eventId: 'e-2', kind: 'handover', occurredAt: `${YEAR}-09-30T09:00:00.000Z`,
  documentId: 'doc-handover', exportDocumentId: 'doc-zip',
  title: `Извештај за примопредавање ${YEAR}-09-30`, fileName: 'primopredavanje.pdf', sizeBytes: 4096, evidence: {},
};

describe('ReportsTab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('issues the annual report for the selected year', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [], documents: [] }))  // 1 list
      .mockResolvedValueOnce(json(preview))                      // 2 preview for the current year
      .mockResolvedValueOnce(json(preview))                      // 3 preview after the year changes
      .mockResolvedValueOnce(json({ document: { id: 'doc-annual' }, exportDocumentId: null, eventId: 'e-1', year: YEAR - 1, fields: preview.fields })) // 4 POST
      .mockResolvedValueOnce(json({ rows: [annualRow], documents: [] })) // 5 list again
      .mockResolvedValueOnce(json(preview));                     // 6 preview again
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(ReportsTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(w.find('[data-test=report-issue-annual]').exists()).toBe(true));

    expect(String(fetchMock.mock.calls[1]![0])).toBe(`http://localhost:3001/api/buildings/b1/reports/annual/preview?year=${YEAR}`);
    expect(w.get('[data-test=report-kpi-billed]').text()).toContain('6.000,00');
    expect(w.get('[data-test=report-kpi-collected]').text()).toContain('3.600,00');
    expect(w.get('[data-test=report-kpi-debt]').text()).toContain('2.400,00');

    await w.get('[data-test=report-year]').setValue(String(YEAR - 1));
    await w.get('[data-test=report-issue-annual]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    await flushPromises();

    // Changing the year reloads the preview (call 3), then the issue posts (call 4).
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(String(post[0])).toBe('http://localhost:3001/api/buildings/b1/reports/annual');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ year: YEAR - 1 });
  });

  it('issues the handover with the typed bank balances as minor units', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [], documents: [] }))
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(json({ document: { id: 'doc-handover' }, exportDocumentId: 'doc-zip', eventId: 'e-2', year: YEAR, fields: preview.fields }))
      .mockResolvedValueOnce(json({ rows: [handoverRow], documents: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(ReportsTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(w.find('[data-test=report-issue-handover]').exists()).toBe(true));

    await w.get('[data-test=handover-as-of]').setValue(`${YEAR}-09-30`);
    await w.get('[data-test=handover-bank-regular]').setValue('12.345,67');
    await w.get('[data-test=handover-bank-reserve]').setValue('9.000,00');
    await w.get('[data-test=handover-note]').setValue('Предадено на новиот управител.');
    await w.get('[data-test=report-issue-handover]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await flushPromises();

    const post = fetchMock.mock.calls[2]!;
    expect(String(post[0])).toBe('http://localhost:3001/api/buildings/b1/reports/handover');
    expect((post[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      asOf: `${YEAR}-09-30`,
      bankBalances: { regularMinor: 1_234_567, reserveMinor: 900_000 },
      note: 'Предадено на новиот управител.',
    });
  });

  it('refuses to post a handover whose bank balances are not amounts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [], documents: [] }))
      .mockResolvedValueOnce(json(preview));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(ReportsTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(w.find('[data-test=report-issue-handover]').exists()).toBe(true));

    await w.get('[data-test=handover-bank-regular]').setValue('сто денари');
    await w.get('[data-test=report-issue-handover]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2); // nothing was sent
    expect(w.get('[data-test=report-error]').text()).toBe('Проверете ги внесените податоци.');
  });

  it('offers the PDF of every filed report and the zip of a handover', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [handoverRow, annualRow], documents: [] }))
      .mockResolvedValueOnce(json(preview));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(ReportsTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(w.findAll('[data-test=row]').length).toBe(2));

    const downloads = w.findAll('[data-test=report-download]');
    expect(downloads).toHaveLength(2);
    expect(downloads[0]!.attributes('href')).toBe('http://localhost:3001/api/documents/doc-handover/download');
    const exports = w.findAll('[data-test=report-export]');
    expect(exports).toHaveLength(1); // only the handover has one
    expect(exports[0]!.attributes('href')).toBe('http://localhost:3001/api/documents/doc-zip/download');
    expect(w.findAll('[data-test=row]')[0]!.text()).toContain('Примопредавање');
  });
});
