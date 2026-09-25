import { describe, expect, it } from 'vitest';
import { mkPack } from '../src/country/mk.js';
import { civilDayStart } from '../src/period.js';
import { buildAnnualReport, yearWindow, type AnnualReportInput, type FundMovementIn } from '../src/reports/annual.js';
import { asOfWindow, buildHandoverReport, type HandoverReportInput } from '../src/reports/handover.js';

const TZ = 'Europe/Skopje';

/**
 * The 2026 book of a three-owner building, with every number picked so the sums are checkable by eye:
 * regular 100.000 + 300.000 − 150.000 = 250.000; reserve 800.000 + 60.000 − 600.000 = 260.000;
 * billed 600.000, collected 360.000 → 60,00 %; debts 180.000 + 60.000 = 240.000.
 */
const annualInput = (): AnnualReportInput => ({
  year: 2026,
  window: { from: '2025-12-31T23:00:00.000Z', to: '2026-12-31T23:00:00.000Z' },
  building: { name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000', unitCount: 4 },
  manager: { name: 'Домар ДООЕЛ', companyNumber: '7654321' },
  opening: { regular: 100_000, reserve: 800_000 },
  fundMovements: [
    { fund: 'regular', kind: 'payment', refType: 'payment', inflowMinor: 300_000, outflowMinor: 0 },
    { fund: 'regular', kind: 'expense', refType: 'expense', inflowMinor: 0, outflowMinor: 150_000 },
    { fund: 'reserve', kind: 'payment', refType: 'payment', inflowMinor: 60_000, outflowMinor: 0 },
    { fund: 'reserve', kind: 'expense', refType: 'expense', inflowMinor: 0, outflowMinor: 600_000 },
  ],
  expenses: [
    { id: 'e1', fund: 'regular', description: 'Струја за заедничките простории', supplier: 'ЕВН Македонија', amountMinor: 150_000, paidAt: '2026-03-05T09:00:00.000Z' },
    { id: 'e2', fund: 'reserve', description: 'Санација на кровот', supplier: 'Кровови ДООЕЛ', amountMinor: 400_000, paidAt: '2026-06-11T09:00:00.000Z' },
    { id: 'e3', fund: 'reserve', description: 'Фасада, влез Б', supplier: 'Кровови ДООЕЛ', amountMinor: 200_000, paidAt: '2026-08-02T09:00:00.000Z' },
  ],
  // Deliberately out of order: the builder sorts, the caller does not have to.
  owners: [
    { contactId: 'c-3', name: 'Вера Велкова', unitLabels: ['3', 'P-1'], billedMinor: 240_000, collectedMinor: 60_000, current: true, balanceMinor: 180_000 },
    { contactId: 'c-1', name: 'Ана Анастасова', unitLabels: ['1'], billedMinor: 180_000, collectedMinor: 180_000, current: true, balanceMinor: 0 },
    { contactId: 'c-2', name: 'Борис Богданов', unitLabels: ['2'], billedMinor: 180_000, collectedMinor: 120_000, current: true, balanceMinor: 60_000 },
  ],
  remindersSent: 4,
  assemblies: [{ heldAt: '2026-05-20T17:00:00.000Z', decisionCount: 2 }],
});

const handoverInput = (over: Partial<HandoverReportInput> = {}): HandoverReportInput => ({
  ...annualInput(),
  window: { from: '2025-12-31T23:00:00.000Z', to: '2026-09-30T22:00:00.000Z' },
  asOf: '2026-09-30',
  contractEndsOn: '2026-09-30',
  openItems: [
    { invoiceId: 'i-2', number: '2026-000002', contactId: 'c-2', ownerName: 'Борис Богданов', period: '2026-08', dueAt: '2026-09-15T00:00:00.000Z', totalMinor: 60_000, paidMinor: 0, outstandingMinor: 60_000 },
    { invoiceId: 'i-3', number: '2026-000003', contactId: 'c-3', ownerName: 'Вера Велкова', period: '2026-08', dueAt: '2026-09-15T00:00:00.000Z', totalMinor: 240_000, paidMinor: 60_000, outstandingMinor: 180_000 },
  ],
  bankBalances: { regularMinor: 250_000, reserveMinor: 265_000, asOf: '2026-09-30' },
  note: 'Предадено на новиот управител.',
  ...over,
});

describe('yearWindow and asOfWindow', () => {
  it('opens and closes the year on local midnight in the tenant zone', () => {
    const w = yearWindow(2026, TZ);
    // Skopje is UTC+1 in January: 1 January 00:00 local is 31 December 23:00 UTC.
    expect(w.from.toISOString()).toBe('2025-12-31T23:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-12-31T23:00:00.000Z');
  });

  it('reads a date-only string onto the civil day, summer offset included', () => {
    // Skopje is UTC+2 in July: 15 July 00:00 local is 14 July 22:00 UTC.
    expect(civilDayStart('2026-07-15', TZ).toISOString()).toBe('2026-07-14T22:00:00.000Z');
    expect(civilDayStart('2026-01-15', TZ).toISOString()).toBe('2026-01-14T23:00:00.000Z');
  });

  it('holds at offsets a noon anchor cannot reach, either side of UTC', () => {
    // +13 in January, +12 in July: noon UTC is already the next civil day in Auckland.
    expect(civilDayStart('2026-01-15', 'Pacific/Auckland').toISOString()).toBe('2026-01-14T11:00:00.000Z');
    expect(civilDayStart('2026-07-15', 'Pacific/Auckland').toISOString()).toBe('2026-07-14T12:00:00.000Z');
    // −8 in January, −7 in July.
    expect(civilDayStart('2026-01-15', 'America/Los_Angeles').toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(civilDayStart('2026-07-15', 'America/Los_Angeles').toISOString()).toBe('2026-07-15T07:00:00.000Z');
    // The spring-forward day still opens at local midnight, before the hour goes missing.
    expect(civilDayStart('2026-03-08', 'America/Los_Angeles').toISOString()).toBe('2026-03-08T08:00:00.000Z');
  });

  it('runs a handover window from 1 January to the end of the asOf day', () => {
    const w = asOfWindow('2026-09-30', TZ);
    expect(w.from.toISOString()).toBe('2025-12-31T23:00:00.000Z');
    // Exclusive end: 1 October 00:00 local, which in CEST is 30 September 22:00 UTC.
    expect(w.to.toISOString()).toBe('2026-09-30T22:00:00.000Z');
  });

  it('crosses the autumn DST change without losing or gaining an hour of the last day', () => {
    // 25 October 2026 is the changeover; the day after it starts at 23:00 UTC, not 22:00.
    expect(asOfWindow('2026-10-25', TZ).to.toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });
});

describe('buildAnnualReport — the funds', () => {
  it('balances each fund: opening + inflow − outflow = closing', () => {
    const r = buildAnnualReport(annualInput());
    expect(r.funds.map((f) => f.fund)).toEqual(['regular', 'reserve']);
    for (const f of r.funds) {
      expect(f.openingMinor + f.inflowMinor - f.outflowMinor, f.fund).toBe(f.closingMinor);
    }
    expect(r.funds[0]).toEqual({
      fund: 'regular', openingMinor: 100_000, inflowMinor: 300_000, outflowMinor: 150_000,
      netInflowMinor: 300_000, netOutflowMinor: 150_000, closingMinor: 250_000,
      movements: [
        { kind: 'expense', refType: 'expense', inflowMinor: 0, outflowMinor: 150_000, netMinor: -150_000 },
        { kind: 'payment', refType: 'payment', inflowMinor: 300_000, outflowMinor: 0, netMinor: 300_000 },
      ],
    });
    expect(r.funds[1]!.closingMinor).toBe(260_000);
  });

  it('gives a fund with no history an opening of zero rather than leaving it out', () => {
    const r = buildAnnualReport({ ...annualInput(), opening: { regular: 0, reserve: 0 }, fundMovements: [] });
    expect(r.funds.map((f) => [f.fund, f.openingMinor, f.inflowMinor, f.outflowMinor, f.netInflowMinor, f.netOutflowMinor, f.closingMinor]))
      .toEqual([['regular', 0, 0, 0, 0, 0, 0], ['reserve', 0, 0, 0, 0, 0, 0]]);
  });
});

/**
 * Every posting kind on one book, with both reversals: regular gets a part-voided payment and a
 * part-voided expense, reserve gets a payment and an expense voided whole. Gross keeps every line the
 * ledger wrote; net is what the year actually took in and actually spent.
 */
const voidMovements = (): FundMovementIn[] => [
  { fund: 'regular', kind: 'opening', refType: 'opening', inflowMinor: 50_000, outflowMinor: 0 },
  { fund: 'regular', kind: 'charge', refType: 'invoice', inflowMinor: 20_000, outflowMinor: 0 },
  // Two rows on one key: the builder merges them into a single movement of 300.000.
  { fund: 'regular', kind: 'payment', refType: 'payment', inflowMinor: 200_000, outflowMinor: 0 },
  { fund: 'regular', kind: 'payment', refType: 'payment', inflowMinor: 100_000, outflowMinor: 0 },
  { fund: 'regular', kind: 'adjustment', refType: 'payment_void', inflowMinor: 0, outflowMinor: 100_000 },
  { fund: 'regular', kind: 'expense', refType: 'expense', inflowMinor: 0, outflowMinor: 150_000 },
  { fund: 'regular', kind: 'adjustment', refType: 'expense_void', inflowMinor: 60_000, outflowMinor: 0 },
  { fund: 'reserve', kind: 'payment', refType: 'payment', inflowMinor: 500_000, outflowMinor: 0 },
  { fund: 'reserve', kind: 'adjustment', refType: 'payment_void', inflowMinor: 0, outflowMinor: 500_000 },
  { fund: 'reserve', kind: 'expense', refType: 'expense', inflowMinor: 0, outflowMinor: 200_000 },
  { fund: 'reserve', kind: 'adjustment', refType: 'expense_void', inflowMinor: 200_000, outflowMinor: 0 },
];

const voidInput = (): AnnualReportInput => ({
  ...annualInput(),
  opening: { regular: 10_000, reserve: 25_000 },
  fundMovements: voidMovements(),
});

describe('buildAnnualReport — voids', () => {
  it('merges the rows of one (kind, refType) key and lists every kind once, in a fixed order', () => {
    const r = buildAnnualReport(voidInput());
    expect(r.funds[0]!.movements).toEqual([
      { kind: 'adjustment', refType: 'expense_void', inflowMinor: 60_000, outflowMinor: 0, netMinor: 60_000 },
      { kind: 'adjustment', refType: 'payment_void', inflowMinor: 0, outflowMinor: 100_000, netMinor: -100_000 },
      { kind: 'charge', refType: 'invoice', inflowMinor: 20_000, outflowMinor: 0, netMinor: 20_000 },
      { kind: 'expense', refType: 'expense', inflowMinor: 0, outflowMinor: 150_000, netMinor: -150_000 },
      { kind: 'opening', refType: 'opening', inflowMinor: 50_000, outflowMinor: 0, netMinor: 50_000 },
      { kind: 'payment', refType: 'payment', inflowMinor: 300_000, outflowMinor: 0, netMinor: 300_000 },
    ]);
  });

  it('nets a voided payment out of income and a voided expense out of spending', () => {
    const r = buildAnnualReport(voidInput());
    // Gross: 50.000 + 20.000 + 300.000 + 60.000 in, 100.000 + 150.000 out.
    expect(r.funds[0]).toMatchObject({
      fund: 'regular', openingMinor: 10_000,
      inflowMinor: 430_000, outflowMinor: 250_000,
      // Net: the 100.000 void leaves income, the 60.000 void leaves spending, and neither is income.
      netInflowMinor: 270_000, netOutflowMinor: 90_000,
      closingMinor: 190_000,
    });
  });

  it('shows a fund whose whole year was voided as having taken in and spent nothing', () => {
    const r = buildAnnualReport(voidInput());
    expect(r.funds[1]).toMatchObject({
      fund: 'reserve', openingMinor: 25_000,
      inflowMinor: 700_000, outflowMinor: 700_000,
      netInflowMinor: 0, netOutflowMinor: 0,
      closingMinor: 25_000,
    });
  });

  it('keeps the invariant on both the gross and the net columns', () => {
    for (const f of buildAnnualReport(voidInput()).funds) {
      expect(f.openingMinor + f.inflowMinor - f.outflowMinor, f.fund).toBe(f.closingMinor);
      expect(f.openingMinor + f.netInflowMinor - f.netOutflowMinor, f.fund).toBe(f.closingMinor);
    }
  });

  it('clamps a void of something this window never booked, so no net column goes negative', () => {
    // December's expense and December's payment, both voided in January: the new year books the two
    // reversals alone, and neither belongs to its income or its spending.
    const r = buildAnnualReport({
      ...annualInput(),
      opening: { regular: 500_000, reserve: 0 },
      fundMovements: [
        { fund: 'regular', kind: 'adjustment', refType: 'expense_void', inflowMinor: 150_000, outflowMinor: 0 },
        { fund: 'regular', kind: 'adjustment', refType: 'payment_void', inflowMinor: 0, outflowMinor: 40_000 },
      ],
    });
    expect(r.funds[0]).toMatchObject({
      openingMinor: 500_000, inflowMinor: 150_000, outflowMinor: 40_000,
      netInflowMinor: 150_000, netOutflowMinor: 40_000, closingMinor: 610_000,
    });
  });

  it('offsets a straddling void only as far as the window\'s own gross reaches', () => {
    // 60.000 of this year's spending is reversed by a 150.000 void; the other 90.000 undoes last
    // year's expense and is reported there, not here.
    const r = buildAnnualReport({
      ...annualInput(),
      opening: { regular: 0, reserve: 0 },
      fundMovements: [
        { fund: 'regular', kind: 'expense', refType: 'expense', inflowMinor: 0, outflowMinor: 60_000 },
        { fund: 'regular', kind: 'adjustment', refType: 'expense_void', inflowMinor: 150_000, outflowMinor: 0 },
      ],
    });
    expect(r.funds[0]).toMatchObject({
      inflowMinor: 150_000, outflowMinor: 60_000,
      netInflowMinor: 90_000, netOutflowMinor: 0, closingMinor: 90_000,
    });
    for (const f of r.funds) {
      expect(f.openingMinor + f.netInflowMinor - f.netOutflowMinor, f.fund).toBe(f.closingMinor);
      expect(f.netInflowMinor, f.fund).toBeGreaterThanOrEqual(0);
      expect(f.netOutflowMinor, f.fund).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('buildAnnualReport — the tables', () => {
  it('groups expenses by supplier, biggest first, and calls the reserve-fund ones works', () => {
    const r = buildAnnualReport(annualInput());
    expect(r.expensesBySupplier).toEqual([
      { supplier: 'Кровови ДООЕЛ', count: 2, amountMinor: 600_000 },
      { supplier: 'ЕВН Македонија', count: 1, amountMinor: 150_000 },
    ]);
    expect(r.works.map((w) => w.id)).toEqual(['e2', 'e3']);
    expect(r.expenses.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']); // oldest payment first
  });

  it('lists owners by name and debtors by amount, biggest debt first', () => {
    const r = buildAnnualReport(annualInput());
    expect(r.owners.map((o) => o.name)).toEqual(['Ана Анастасова', 'Борис Богданов', 'Вера Велкова']);
    expect(r.debtors).toEqual([
      { contactId: 'c-3', name: 'Вера Велкова', unitLabels: ['3', 'P-1'], balanceMinor: 180_000 },
      { contactId: 'c-2', name: 'Борис Богданов', unitLabels: ['2'], balanceMinor: 60_000 },
    ]);
  });

  it('lists somebody who sold during the year with no units, and still counts their debt', () => {
    const input = annualInput();
    input.owners = [...input.owners,
      { contactId: 'c-9', name: 'Жаклина Жежова', unitLabels: [], billedMinor: 60_000, collectedMinor: 0, current: false, balanceMinor: 60_000 }];
    const r = buildAnnualReport(input);
    expect(r.owners.find((o) => o.contactId === 'c-9')).toMatchObject({ current: false, unitLabels: [] });
    expect(r.owners.filter((o) => !o.current)).toHaveLength(1);
    // Equal debts, so the pack's alphabet decides: Борис before Жаклина.
    expect(r.debtors.map((d) => d.contactId)).toEqual(['c-3', 'c-2', 'c-9']);
    expect(r.fields.ownerCount).toBe(4);
    expect(r.fields.billedMinor).toBe(660_000);
    expect(r.fields.debtorsCount).toBe(3);
    expect(r.fields.totalDebtMinor).toBe(300_000);
  });

  it('hands back rows the caller cannot mutate the input through', () => {
    const input = annualInput();
    const r = buildAnnualReport(input);
    r.expenses[0]!.amountMinor = 1;
    r.owners[0]!.name = 'мутирано';
    r.owners[0]!.unitLabels.push('x');
    r.debtors[0]!.unitLabels.push('x');
    r.assemblies[0]!.decisionCount = 99;
    expect(input.expenses.map((e) => e.amountMinor)).toEqual([150_000, 400_000, 200_000]);
    expect(input.owners.map((o) => o.name)).toEqual(['Вера Велкова', 'Ана Анастасова', 'Борис Богданов']);
    expect(input.owners.map((o) => o.unitLabels)).toEqual([['3', 'P-1'], ['1'], ['2']]);
    expect(input.assemblies[0]!.decisionCount).toBe(2);
  });

  it("orders names by the pack's alphabet, in which Ќ follows Т", () => {
    const input = annualInput();
    input.owners = [
      { contactId: 'c-k', name: 'Ќиро Ќирков', unitLabels: ['4'], billedMinor: 0, collectedMinor: 0, current: true, balanceMinor: 10_000 },
      { contactId: 'c-t', name: 'Тодор Тодоров', unitLabels: ['5'], billedMinor: 0, collectedMinor: 0, current: true, balanceMinor: 10_000 },
    ];
    const r = buildAnnualReport(input);
    expect(r.owners.map((o) => o.name)).toEqual(['Тодор Тодоров', 'Ќиро Ќирков']);
    // Equal debts fall back to the same alphabet.
    expect(r.debtors.map((d) => d.name)).toEqual(['Тодор Тодоров', 'Ќиро Ќирков']);
  });

  it('never counts a credit balance as a debt', () => {
    const input = annualInput();
    input.owners[1]!.balanceMinor = -25_000; // Ана paid ahead
    const r = buildAnnualReport(input);
    expect(r.debtors.map((d) => d.contactId)).toEqual(['c-3', 'c-2']);
    expect(r.fields.totalDebtMinor).toBe(240_000);
  });
});

describe('buildAnnualReport — the fields map', () => {
  it('is the whole scalar surface of the template, and nothing else', () => {
    expect(buildAnnualReport(annualInput()).fields).toEqual({
      year: 2026,
      periodFrom: '2025-12-31T23:00:00.000Z',
      periodTo: '2026-12-31T23:00:00.000Z',
      buildingName: 'Партизанска 12',
      buildingAddress: 'Партизанска 12, 1000 Скопје',
      managerName: 'Домар ДООЕЛ',
      managerCompanyNumber: '7654321',
      unitCount: 4,
      ownerCount: 3,
      regularOpeningMinor: 100_000, regularInflowMinor: 300_000, regularOutflowMinor: 150_000, regularClosingMinor: 250_000,
      reserveOpeningMinor: 800_000, reserveInflowMinor: 60_000, reserveOutflowMinor: 600_000, reserveClosingMinor: 260_000,
      billedMinor: 600_000, collectedMinor: 360_000, expensesMinor: 750_000, collectionRateBp: 6000,
      debtorsCount: 2, totalDebtMinor: 240_000,
      remindersSent: 4, assembliesHeld: 1, decisionsTaken: 2,
      worksCount: 2, worksMinor: 600_000,
    });
  });

  it('reports a collection rate of zero for a year in which nothing was billed', () => {
    const r = buildAnnualReport({ ...annualInput(), owners: [] });
    expect(r.fields.billedMinor).toBe(0);
    expect(r.fields.collectedMinor).toBe(0);
    expect(r.fields.collectionRateBp).toBe(0);
    expect(r.fields.ownerCount).toBe(0);
    expect(r.fields.debtorsCount).toBe(0);
  });

  it('never lets a void of a payment this window never took in drive collections negative', () => {
    const input = annualInput();
    // Last year's payment, voided in this one: the owner paid nothing this year, and the void's
    // posting is all the window sees of it. Its original belongs to last year's report.
    input.owners = [
      { contactId: 'c-1', name: 'Ана', unitLabels: ['1'], billedMinor: 300_000, collectedMinor: -250_000, current: true, balanceMinor: 300_000 },
      { contactId: 'c-2', name: 'Борис', unitLabels: ['2'], billedMinor: 300_000, collectedMinor: 120_000, current: true, balanceMinor: 180_000 },
    ];
    const r = buildAnnualReport(input);
    expect(r.owners.find((o) => o.contactId === 'c-1')!.collectedMinor).toBe(0);
    expect(r.owners.find((o) => o.contactId === 'c-2')!.collectedMinor).toBe(120_000);
    expect(r.fields.collectedMinor).toBe(120_000);
    expect(r.fields.collectionRateBp).toBe(2000);
  });

  it('nets a payment voided inside the window to exactly zero collected, not below', () => {
    const input = annualInput();
    input.owners = [{ contactId: 'c-1', name: 'Ана', unitLabels: ['1'], billedMinor: 300_000, collectedMinor: 0, current: true, balanceMinor: 300_000 }];
    const r = buildAnnualReport(input);
    expect(r.owners[0]!.collectedMinor).toBe(0);
    expect(r.fields.collectedMinor).toBe(0);
    expect(r.fields.collectionRateBp).toBe(0);
  });

  it('rounds the collection rate half up, in basis points', () => {
    const input = annualInput();
    input.owners = [{ contactId: 'c-1', name: 'Ана', unitLabels: ['1'], billedMinor: 300_000, collectedMinor: 100_000, current: true, balanceMinor: 200_000 }];
    // 100.000 / 300.000 = 33,3333 % → 3333 basis points.
    expect(buildAnnualReport(input).fields.collectionRateBp).toBe(3333);
  });

  it('prints an empty company number rather than the word undefined', () => {
    const r = buildAnnualReport({ ...annualInput(), manager: { name: 'Домар ДООЕЛ', companyNumber: null } });
    expect(r.fields.managerCompanyNumber).toBe('');
  });
});

describe('buildHandoverReport', () => {
  it('carries the annual data of the year so far and adds the handover fields', () => {
    const r = buildHandoverReport(handoverInput());
    expect(r.annual.funds[0]!.closingMinor).toBe(250_000);
    expect(r.owners.map((o) => o.name)).toEqual(['Ана Анастасова', 'Борис Богданов', 'Вера Велкова']);
    expect(r.fields.year).toBe(2026);
    expect(r.fields.asOf).toBe('2026-09-30');
    expect(r.fields.contractEndsOn).toBe('2026-09-30');
    expect(r.fields.note).toBe('Предадено на новиот управител.');
    expect(r.fields.periodTo).toBe('2026-09-30T22:00:00.000Z');
  });

  it('reconciles each fund against the bank and names the difference', () => {
    const r = buildHandoverReport(handoverInput());
    expect(r.reconciliation).toEqual([
      { fund: 'regular', ledgerMinor: 250_000, bankMinor: 250_000, differenceMinor: 0 },
      { fund: 'reserve', ledgerMinor: 260_000, bankMinor: 265_000, differenceMinor: 5_000 },
    ]);
    expect(r.fields.bankRegularMinor).toBe(250_000);
    expect(r.fields.bankReserveMinor).toBe(265_000);
    expect(r.fields.regularDifferenceMinor).toBe(0);
    expect(r.fields.reserveDifferenceMinor).toBe(5_000);
    expect(r.fields.bankAsOf).toBe('2026-09-30');
  });

  it('lists the open items biggest first and totals them', () => {
    const r = buildHandoverReport(handoverInput());
    expect(r.openItems.map((i) => i.invoiceId)).toEqual(['i-3', 'i-2']);
    expect(r.fields.openItemsCount).toBe(2);
    expect(r.fields.openItemsMinor).toBe(240_000);
    // The two agree because every open item is somebody's debt: a cross-check worth keeping.
    expect(r.fields.openItemsMinor).toBe(r.fields.totalDebtMinor);
  });

  it('hands back open items the caller cannot mutate the input through', () => {
    const input = handoverInput();
    const r = buildHandoverReport(input);
    r.openItems[0]!.outstandingMinor = 1;
    expect(input.openItems.map((i) => i.outstandingMinor)).toEqual([60_000, 180_000]);
  });

  it('is well-formed for a building handed over with no contract end on file and no open items', () => {
    const r = buildHandoverReport(handoverInput({ contractEndsOn: null, openItems: [], note: null }));
    expect(r.fields.contractEndsOn).toBe('');
    expect(r.fields.note).toBe('');
    expect(r.fields.openItemsCount).toBe(0);
    expect(r.fields.openItemsMinor).toBe(0);
    expect(r.openItems).toEqual([]);
  });
});

describe('mk pack report labels', () => {
  it('carries the Art. 31 and Art. 30 sentences the two documents print', () => {
    expect(mkPack.labels.reports.annualTitle).toBe('Годишен извештај');
    expect(mkPack.labels.reports.annualLegal).toContain('член 31');
    expect(mkPack.labels.reports.handoverTitle).toBe('Извештај за примопредавање');
    expect(mkPack.labels.reports.handoverLegal).toContain('член 30');
    expect(mkPack.labels.reports.handoverLegal).toContain('8');
    expect(mkPack.labels.reports.noSupplier).toBe('Без добавувач');
  });
});
